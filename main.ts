import {
  App,
  moment,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile
} from "obsidian";
import {
  buildTagMatchRegex,
  ensureTaskIdTagOnLine,
  buildTaskLineFromInput,
  formatTaskTextForMessage,
  getUncheckedTaskText,
  hasTaskIdTag,
  isTaskLine,
  isTaskCompleted,
  isTaskLike,
  matchesTaskLine,
  normalizeTasksQuery,
  normalizeTagFilter,
  parseDueFromRaw,
  parsePriorityFromRaw,
  replaceCheckbox,
  taskMatchesGlobalTag,
  toTaskRecord,
  type TaskRecord,
  type TaskLike
} from "./tasks";
import {
  DEFAULT_SETTINGS,
  formatChatIds,
  formatAllowedUserIds,
  parseChatIds,
  parseAllowedUserIds,
  type TaskIdTaggingMode,
  type TelegramTasksNotifierSettings
} from "./settings";
import { TelegramClient, type TelegramUpdate } from "./telegram";
import { buildTaskIdTagRegexForId, getStoredTaskId, hashTaskId } from "./task-id";
import * as dailyNotesInterface from "obsidian-daily-notes-interface";

type DailyNoteSettings = {
  folder?: string;
  format?: string;
  template?: string;
};

const dailyNotesApi = dailyNotesInterface as {
  getDailyNoteSettings?: () => DailyNoteSettings | null;
  getAllDailyNotes?: () => Record<string, TFile> | Map<string, TFile> | null;
  createDailyNote?: (date: unknown, settings: DailyNoteSettings) => Promise<TFile>;
};

type TasksApi = {
  getTasks?: (query: string) => Promise<unknown[]> | unknown[];
  getTasksFromQuery?: (query: string) => Promise<unknown[]> | unknown[];
  queryTasks?: (query: string) => Promise<unknown[]> | unknown[];
};

const TELEGRAM_SAFE_MESSAGE_LENGTH = 3900;
const TELEGRAM_MAX_LINE_LENGTH = 3500;

export default class TelegramTasksNotifierPlugin extends Plugin {
  settings: TelegramTasksNotifierSettings;
  private telegramClient: TelegramClient;
  private notificationIntervalId: number | null = null;
  private pollingLoopPromise: Promise<void> | null = null;
  private pollingAbort = false;
  private pollingInFlight = false;
  private sendInFlight = false;
  private pollingErrorStreak = 0;
  private taskCache = new Map<string, TaskRecord>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.telegramClient = new TelegramClient(() => this.settings);

    this.addSettingTab(new TelegramTasksNotifierSettingTab(this.app, this));
    this.addCommand({
      id: "send-telegram-tasks",
      name: "Send unfinished tasks to Telegram",
      callback: async () => {
        await this.sendTasksNotification();
      }
    });
    this.addCommand({
      id: "poll-telegram-updates",
      name: "Poll Telegram updates",
      callback: async () => {
        await this.pollTelegramUpdates();
      }
    });
    this.addCommand({
      id: "detect-telegram-chat-id",
      name: "Detect Telegram requestor chat ID",
      callback: async () => {
        await this.detectTelegramChatId();
      }
    });

    this.configureIntervals();

    if (this.settings.notifyOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        void this.sendTasksNotificationWithRetry();
      });
    }
  }

  onunload(): void {
    this.clearIntervals();
  }

  private configureIntervals(): void {
    this.clearIntervals();

    if (this.settings.notificationIntervalMinutes > 0) {
      this.notificationIntervalId = window.setInterval(() => {
        void this.sendTasksNotification();
      }, this.settings.notificationIntervalMinutes * 60 * 1000);
    }

    if (this.settings.enableTelegramPolling && this.settings.pollIntervalSeconds > 0) {
      this.startPollingLoop();
    }
  }

  private clearIntervals(): void {
    if (this.notificationIntervalId !== null) {
      window.clearInterval(this.notificationIntervalId);
      this.notificationIntervalId = null;
    }
    this.stopPollingLoop();
  }

  private startPollingLoop(): void {
    if (this.pollingLoopPromise) {
      return;
    }
    this.pollingAbort = false;
    this.pollingLoopPromise = this.pollTelegramUpdatesLoop().finally(() => {
      this.pollingLoopPromise = null;
    });
  }

  private stopPollingLoop(): void {
    this.pollingAbort = true;
  }

  private async pollTelegramUpdatesLoop(): Promise<void> {
    while (!this.pollingAbort && this.settings.enableTelegramPolling) {
      try {
        await this.pollTelegramUpdates();
        this.pollingErrorStreak = 0;
      } catch (error) {
        this.pollingErrorStreak += 1;
        const backoff = this.getPollingBackoffMs(this.pollingErrorStreak);
        console.warn("Telegram polling failed", error);
        new Notice("Telegram polling failed. Retrying soon.");
        await this.sleep(backoff);
      }
    }
  }

  private getPollingBackoffMs(errorStreak: number): number {
    const baseMs = 1000;
    const maxMs = 30000;
    const backoff = baseMs * Math.pow(2, Math.min(4, errorStreak));
    const jitter = Math.floor(Math.random() * 500);
    return Math.min(maxMs, backoff + jitter);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveSettingsAndReconfigure(): Promise<void> {
    await this.saveSettings();
    this.configureIntervals();
  }

  private getTasksApi(): TasksApi | null {
    const plugin = (this.app as App & { plugins?: { plugins?: Record<string, unknown> } }).plugins
      ?.plugins?.["obsidian-tasks-plugin"] as {
      apiV1?: TasksApi;
    } | undefined;
    return plugin?.apiV1 ?? null;
  }

  private normalizeQueryResult(result: unknown): unknown[] {
    if (Array.isArray(result)) {
      return result;
    }
    if (result && typeof result === "object") {
      const maybeTasks = (result as { tasks?: unknown[] }).tasks;
      if (Array.isArray(maybeTasks)) {
        return maybeTasks;
      }
      const maybeItems = (result as { items?: unknown[] }).items;
      if (Array.isArray(maybeItems)) {
        return maybeItems;
      }
      const maybeResults = (result as { results?: unknown[] }).results;
      if (Array.isArray(maybeResults)) {
        return maybeResults;
      }
    }
    return [];
  }

  private async queryTasksFromApi(api: TasksApi): Promise<TaskLike[] | null> {
    const query = normalizeTasksQuery(this.settings.tasksQuery);
    const queryFn = api.getTasks ?? api.getTasksFromQuery ?? api.queryTasks;
    if (!queryFn) {
      return null;
    }

    try {
      const result = await queryFn.call(api, query);
      const tasks = this.normalizeQueryResult(result).filter(isTaskLike);
      if (tasks.length > 0 || query.length === 0) {
        return tasks;
      }
    } catch (error) {
      console.warn("Failed Tasks query with string", error);
    }

    try {
      const result = await queryFn.call(api, { query });
      return this.normalizeQueryResult(result).filter(isTaskLike);
    } catch (error) {
      console.warn("Failed Tasks query with object", error);
      return null;
    }
  }

  private shouldPersistTaskIdTags(mode: TaskIdTaggingMode = this.settings.taskIdTaggingMode): boolean {
    return mode === "always";
  }

  private async collectTasks(): Promise<TaskRecord[]> {
    const api = this.getTasksApi();
    if (!api) {
      const tasks = await this.collectTasksFromVault();
      return this.sortTasks(tasks);
    }

    const tasks = await this.queryTasksFromApi(api);
    if (tasks === null) {
      const fallback = await this.collectTasksFromVault();
      return this.sortTasks(fallback);
    }

    const tagMatcher = buildTagMatchRegex(this.settings.globalFilterTag);
    const records = tasks
      .filter((task) => !isTaskCompleted(task))
      .map((task) => {
        const record = toTaskRecord(task);
        return { task, record };
      })
      .filter(({ task, record }) => taskMatchesGlobalTag(task, record, this.settings.globalFilterTag, tagMatcher))
      .map(({ record }) => record);

    if (this.shouldPersistTaskIdTags()) {
      await this.persistTaskIdTags(records);
    }

    return this.sortTasks(records);
  }

  private async collectTasksFromVault(): Promise<TaskRecord[]> {
    const records: TaskRecord[] = [];
    const files = this.app.vault.getMarkdownFiles();
    const tagRegex = buildTagMatchRegex(this.settings.globalFilterTag);
    const shouldTag = this.shouldPersistTaskIdTags();

    for (const file of files) {
      const contents = await this.app.vault.read(file);
      const lines = contents.split("\n");
      let changed = false;

      for (let i = 0; i < lines.length; i += 1) {
        const lineText = lines[i];
        const taskText = getUncheckedTaskText(lineText);
        if (taskText === null) {
          continue;
        }
        if (tagRegex && !tagRegex.test(lineText)) {
          continue;
        }
        const text = taskText.trim() || "(unnamed task)";
        const storedId = getStoredTaskId(lineText);
        const id = storedId ?? hashTaskId(`${file.path}::${i}::${lineText}`);
        const shortId = id.slice(0, 8);
        const priority = parsePriorityFromRaw(lineText) ?? 0;
        const dueTimestamp = parseDueFromRaw(lineText);

        if (shouldTag && !storedId) {
          lines[i] = ensureTaskIdTagOnLine(lineText, id);
          changed = true;
        }

        records.push({
          id,
          shortId,
          text,
          path: file.path,
          line: i,
          raw: lineText,
          priority,
          dueTimestamp
        });
      }

      if (changed) {
        await this.app.vault.modify(file, lines.join("\n"));
      }
    }

    return records;
  }

  private async persistTaskIdTags(records: TaskRecord[]): Promise<void> {
    if (!this.shouldPersistTaskIdTags()) {
      return;
    }
    const recordsByPath = new Map<string, TaskRecord[]>();
    for (const record of records) {
      if (!record.path) {
        continue;
      }
      const existing = recordsByPath.get(record.path) ?? [];
      existing.push(record);
      recordsByPath.set(record.path, existing);
    }

    for (const [path, fileRecords] of recordsByPath) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        continue;
      }
      const contents = await this.app.vault.read(file);
      const lines = contents.split("\n");
      let changed = false;

      for (const record of fileRecords) {
        if (!record.id) {
          continue;
        }
        const candidateIndexes: number[] = [];
        if (typeof record.line === "number") {
          candidateIndexes.push(record.line, record.line - 1);
        }

        let updated = false;
        for (const index of candidateIndexes) {
          if (index < 0 || index >= lines.length) {
            continue;
          }
          if (!matchesTaskLine(lines[index], record, true)) {
            continue;
          }
          if (hasTaskIdTag(lines[index])) {
            updated = true;
            break;
          }
          lines[index] = ensureTaskIdTagOnLine(lines[index], record.id);
          changed = true;
          updated = true;
          break;
        }

        if (updated) {
          continue;
        }

        for (let i = 0; i < lines.length; i += 1) {
          if (!matchesTaskLine(lines[i], record, true)) {
            continue;
          }
          if (hasTaskIdTag(lines[i])) {
            break;
          }
          lines[i] = ensureTaskIdTagOnLine(lines[i], record.id);
          changed = true;
          break;
        }
      }

      if (changed) {
        await this.app.vault.modify(file, lines.join("\n"));
      }
    }
  }

  private sortTasks(records: TaskRecord[]): TaskRecord[] {
    const indexed = records.map((task, index) => ({ task, index }));
    indexed.sort((a, b) => {
      if (a.task.priority !== b.task.priority) {
        return b.task.priority - a.task.priority;
      }
      const aDue = a.task.dueTimestamp ?? Number.POSITIVE_INFINITY;
      const bDue = b.task.dueTimestamp ?? Number.POSITIVE_INFINITY;
      if (aDue !== bDue) {
        return aDue - bDue;
      }
      return a.index - b.index;
    });
    return indexed.map(({ task }) => task);
  }

  async sendTasksNotification(): Promise<void> {
    if (this.sendInFlight) {
      return;
    }
    this.sendInFlight = true;
    try {
      const tasks = await this.collectTasks();
      await this.sendTasksNotificationWithTasks(tasks);
    } finally {
      this.sendInFlight = false;
    }
  }

  private async sendTasksNotificationWithRetry(): Promise<void> {
    const attempts = 4;
    const delayMs = 1500;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const tasks = await this.collectTasks();
      if (tasks.length > 0 || attempt === attempts - 1) {
        await this.sendTasksNotificationWithTasks(tasks);
        return;
      }
      await this.sleep(delayMs);
    }
  }

  private async sendTasksNotificationWithTasks(
    tasks: TaskRecord[],
    options: { allowEmpty?: boolean } = {}
  ): Promise<void> {
    if (!this.settings.botToken.trim()) {
      new Notice("Telegram bot token is missing.");
      return;
    }

    const targets: Array<{ chatId: string | number; role: "host" | "guest" }> = [];
    const seen = new Set<string>();
    const hostChatId = this.getHostChatIdValue();
    if (hostChatId) {
      seen.add(String(hostChatId));
      targets.push({ chatId: hostChatId, role: "host" });
    }
    for (const guestChatId of this.settings.guestChatIds) {
      const key = String(guestChatId);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push({ chatId: guestChatId, role: "guest" });
    }

    if (targets.length === 0) {
      new Notice("Telegram host or guest chat IDs are missing.");
      return;
    }

    this.taskCache.clear();
    tasks.forEach((task) => this.taskCache.set(task.id, task));

    if (tasks.length === 0) {
      if (options.allowEmpty) {
        for (const target of targets) {
          await this.safeTelegramCall("send message", () =>
            this.telegramClient.sendMessageTo(target.chatId, "No unfinished tasks found.")
          );
        }
      } else {
        new Notice("No unfinished tasks found.");
      }
      return;
    }

    for (const target of targets) {
      await this.sendTasksNotificationToChat(tasks, target.chatId, target.role, options);
    }
  }

  private async sendTasksNotificationToChat(
    tasks: TaskRecord[],
    chatId: string | number,
    role: "host" | "guest",
    options: { allowEmpty?: boolean } = {}
  ): Promise<void> {
    const scopedTasks = role === "guest" ? tasks.filter((task) => this.isSharedTask(task)) : tasks;
    if (scopedTasks.length === 0) {
      if (options.allowEmpty) {
        await this.safeTelegramCall("send message", () =>
          this.telegramClient.sendMessageTo(chatId, "No unfinished tasks found.")
        );
      } else if (role === "host") {
        new Notice("No unfinished tasks found.");
      }
      return;
    }

    const maxTasks = Math.max(1, this.settings.maxTasksPerNotification);
    const shownTasks = scopedTasks.slice(0, maxTasks);
    const tagMatcher = buildTagMatchRegex(this.settings.globalFilterTag);
    const sharedMatcher = buildTagMatchRegex("#shared");
    const header = `Unfinished tasks: ${scopedTasks.length}`;
    const lines = shownTasks.map((task) => {
      const location = this.settings.includeFilePath && task.path
        ? ` (${task.path}${task.line !== null ? ":" + (task.line + 1) : ""})`
        : "";
      return `- ${formatTaskTextForMessage(task.text, tagMatcher, [sharedMatcher])}${location} #${task.shortId}`;
    });
    const footer = scopedTasks.length > shownTasks.length
      ? `...and ${scopedTasks.length - shownTasks.length} more`
      : "";

    const messages = this.buildTelegramMessages(header, lines, footer);
    if (messages.length === 0) {
      return;
    }

    const replyMarkup = {
      inline_keyboard: [
        ...shownTasks.map((task) => [
          {
            text: `Done #${task.shortId}`,
            callback_data: `done:${task.id}`
          }
        ]),
        [
          {
            text: "List",
            callback_data: "list"
          }
        ]
      ]
    };

    for (let i = 0; i < messages.length; i += 1) {
      const text = messages[i];
      const markup = i === 0 ? replyMarkup : undefined;
      const sent = await this.safeTelegramCall("send message", () =>
        this.telegramClient.sendMessageTo(chatId, text, markup)
      );
      if (!sent) {
        return;
      }
    }
  }

  private buildTelegramMessages(header: string, lines: string[], footer: string): string[] {
    const messages: string[] = [];
    const continuedHeader = "Unfinished tasks (continued):";

    let buffer: string[] = [header, ""];
    let currentLength = buffer.join("\n").length;

    const pushBuffer = (): void => {
      const text = buffer.join("\n").trimEnd();
      if (text) {
        messages.push(text);
      }
    };

    const addLine = (line: string): void => {
      const trimmedLine = line.length > TELEGRAM_MAX_LINE_LENGTH
        ? `${line.slice(0, TELEGRAM_MAX_LINE_LENGTH - 3)}...`
        : line;
      const nextLength = currentLength + trimmedLine.length + 1;
      if (nextLength > TELEGRAM_SAFE_MESSAGE_LENGTH) {
        pushBuffer();
        buffer = [continuedHeader, ""];
        currentLength = buffer.join("\n").length;
      }
      buffer.push(trimmedLine);
      currentLength += trimmedLine.length + 1;
    };

    for (const line of lines) {
      addLine(line);
    }

    if (footer) {
      const footerLength = currentLength + footer.length + 1;
      if (footerLength > TELEGRAM_SAFE_MESSAGE_LENGTH) {
        pushBuffer();
        buffer = [continuedHeader, ""];
        currentLength = buffer.join("\n").length;
      }
      buffer.push(footer);
    }

    pushBuffer();
    return messages;
  }

  private async safeTelegramCall<T>(label: string, action: () => Promise<T>): Promise<T | null> {
    try {
      return await action();
    } catch (error) {
      console.warn(`Telegram ${label} failed`, error);
      new Notice(`Telegram ${label} failed. Check your connection or bot settings.`);
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private parseHostChatId(): number | null {
    const configured = this.settings.hostChatId.trim();
    if (!configured) {
      return null;
    }
    const parsed = Number.parseInt(configured, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private getHostChatIdValue(): string | null {
    const configured = this.settings.hostChatId.trim();
    if (!configured) {
      return null;
    }
    const parsed = Number.parseInt(configured, 10);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return configured;
  }

  private isHostChatId(chatId: number | undefined | null): boolean {
    const hostChatId = this.parseHostChatId();
    if (hostChatId === null || chatId === undefined || chatId === null) {
      return false;
    }
    return hostChatId === chatId;
  }

  private isGuestChatId(chatId: number | undefined | null): boolean {
    if (chatId === undefined || chatId === null) {
      return false;
    }
    return this.settings.guestChatIds.includes(chatId);
  }

  private getChatRole(chatId: number | undefined | null): "host" | "guest" | "unknown" {
    if (this.isHostChatId(chatId)) {
      return "host";
    }
    if (this.isGuestChatId(chatId)) {
      return "guest";
    }
    return "unknown";
  }

  private isSharedTask(task: TaskRecord): boolean {
    const matcher = buildTagMatchRegex("#shared");
    if (!matcher) {
      return false;
    }
    const raw = task.raw ?? "";
    if (raw && matcher.test(raw)) {
      return true;
    }
    const text = task.text ?? "";
    return matcher.test(text);
  }

  private async addRequestorChatId(chatId: number): Promise<void> {
    if (!Number.isFinite(chatId)) {
      return;
    }
    if (this.settings.requestors.includes(chatId)) {
      return;
    }
    this.settings.requestors = [...this.settings.requestors, chatId];
    await this.saveSettings();
  }

  private isAllowedTelegramUser(userId: number | undefined | null): boolean {
    if (userId === undefined || userId === null) {
      return false;
    }
    const allowed = this.settings.allowedTelegramUserIds;
    if (!allowed || allowed.length === 0) {
      return true;
    }
    return allowed.includes(userId);
  }

  private isAuthorizedUpdate(chatId: number | undefined | null, userId: number | undefined | null): boolean {
    const role = this.getChatRole(chatId);
    if (role === "unknown") {
      return false;
    }
    return this.isAllowedTelegramUser(userId);
  }

  private async pollTelegramUpdates(): Promise<void> {
    if (!this.settings.enableTelegramPolling) {
      return;
    }
    if (!this.settings.botToken.trim()) {
      return;
    }
    if (this.pollingInFlight) {
      return;
    }
    if (this.settings.pollIntervalSeconds <= 0) {
      return;
    }

    this.pollingInFlight = true;
    try {
      const offset = this.settings.lastUpdateId + 1;
      const timeoutSeconds = Math.max(1, this.settings.pollIntervalSeconds);
      const updates = await this.telegramClient.getUpdates(offset, timeoutSeconds);
      if (updates.length === 0) {
        return;
      }

      let latestUpdateId = this.settings.lastUpdateId;
      for (const update of updates) {
        latestUpdateId = Math.max(latestUpdateId, update.update_id);

        const callback = update.callback_query;
        if (callback?.data === "list") {
          const callbackChatId = callback.message?.chat?.id;
          const callbackUserId = callback.from?.id;
          const role = this.getChatRole(callbackChatId);

          if (role === "unknown" || !this.isAuthorizedUpdate(callbackChatId, callbackUserId)) {
            await this.safeTelegramCall("answer callback query", () =>
              this.telegramClient.answerCallbackQuery(callback.id, "Unauthorized")
            );
            continue;
          }

          const tasks = await this.collectTasks();
          if (callbackChatId !== undefined && callbackChatId !== null) {
            await this.sendTasksNotificationToChat(tasks, callbackChatId, role, { allowEmpty: true });
          }
          await this.safeTelegramCall("answer callback query", () =>
            this.telegramClient.answerCallbackQuery(callback.id, "Sent task list")
          );
          continue;
        }

        if (callback?.data?.startsWith("done:")) {
          const taskId = callback.data.slice("done:".length);
          const callbackChatId = callback.message?.chat?.id;
          const callbackUserId = callback.from?.id;
          const role = this.getChatRole(callbackChatId);

          if (role === "unknown" || !this.isAuthorizedUpdate(callbackChatId, callbackUserId)) {
            await this.safeTelegramCall("answer callback query", () =>
              this.telegramClient.answerCallbackQuery(callback.id, "Unauthorized")
            );
            continue;
          }

          const success = await this.completeTaskById(taskId, role);
          await this.safeTelegramCall("answer callback query", () =>
            this.telegramClient.answerCallbackQuery(
              callback.id,
              success ? "Task marked complete" : "Task not found"
            )
          );
          continue;
        }

        const messageText = update.message?.text ?? "";
        const chatId = update.message?.chat?.id;
        const userId = update.message?.from?.id;
        const isBot = update.message?.from?.is_bot;
        if (isBot) {
          continue;
        }

        const startMatch = messageText.match(/^\s*\/start(?:@\S+)?\s*$/i);
        if (startMatch && chatId !== undefined && chatId !== null) {
          await this.addRequestorChatId(chatId);
        }

        const role = this.getChatRole(chatId);
        if (role === "unknown") {
          continue;
        }

        const listMatch = messageText.match(/^\s*\/list(?:@\S+)?\s*$/i);
        if (listMatch) {
          if (!this.isAllowedTelegramUser(userId)) {
            continue;
          }
          const tasks = await this.collectTasks();
          if (chatId !== undefined && chatId !== null) {
            await this.sendTasksNotificationToChat(tasks, chatId, role, { allowEmpty: true });
          }
          continue;
        }

        const doneMatch = messageText.match(/^\s*done\s+([a-f0-9]+)\s*$/i);
        if (doneMatch) {
          if (!this.isAllowedTelegramUser(userId)) {
            continue;
          }
          await this.completeTaskById(doneMatch[1], role);
          continue;
        }

        const trimmedMessage = messageText.trim();
        if (!trimmedMessage || trimmedMessage.startsWith("/")) {
          continue;
        }

        if (chatId !== undefined && chatId !== null) {
          await this.addTaskFromTelegram(trimmedMessage, { role, chatId });
        }
      }

      if (latestUpdateId !== this.settings.lastUpdateId) {
        this.settings.lastUpdateId = latestUpdateId;
        await this.saveSettings();
      }
    } finally {
      this.pollingInFlight = false;
    }
  }

  async detectTelegramChatId(): Promise<void> {
    if (!this.settings.botToken.trim()) {
      new Notice("Telegram bot token is missing.");
      return;
    }

    const updates = await this.telegramClient.getUpdates(0, 0);
    if (updates.length === 0) {
      new Notice("No Telegram updates found. Send /start to the bot first.");
      return;
    }

    const ordered = [...updates].sort((a, b) => a.update_id - b.update_id);
    let latestUpdateId = this.settings.lastUpdateId;
    let detectedChatId: number | null = null;
    let startChatId: number | null = null;

    for (const update of ordered) {
      latestUpdateId = Math.max(latestUpdateId, update.update_id);
      const messageChatId = update.message?.chat?.id ?? null;
      const callbackChatId = update.callback_query?.message?.chat?.id ?? null;

      if (update.message?.text && /^\s*\/start\b/i.test(update.message.text)) {
        startChatId = messageChatId;
      }

      if (messageChatId !== null) {
        detectedChatId = messageChatId;
      } else if (callbackChatId !== null) {
        detectedChatId = callbackChatId;
      }
    }

    const resolvedChatId = startChatId ?? detectedChatId;
    if (resolvedChatId === null) {
      new Notice("No chat ID found in updates.");
      return;
    }

    if (!startChatId) {
      new Notice("No /start message found. Using latest chat ID from updates.");
    }

    if (!this.settings.requestors.includes(resolvedChatId)) {
      this.settings.requestors = [...this.settings.requestors, resolvedChatId];
    }
    this.settings.lastUpdateId = latestUpdateId;
    await this.saveSettings();
    new Notice(`Recorded requestor chat ID ${resolvedChatId}`);
  }

  private async resolveLatestDailyNoteFile(): Promise<TFile | null> {
    const rawSettings = dailyNotesApi.getDailyNoteSettings?.() ?? null;
    const settings =
      this.normalizeDailyNoteSettings(rawSettings) ?? { format: "YYYY-MM-DD", folder: "" };
    const overridePath = this.resolveOverrideDailyNotePath(settings);
    if (overridePath) {
      const ensured = await this.ensureDailyNoteFile(overridePath);
      if (ensured) {
        return ensured;
      }
      new Notice("Daily note path override could not be created.");
      return null;
    }
    let allNotes: Record<string, TFile> | Map<string, TFile> | null = null;
    try {
      allNotes = dailyNotesApi.getAllDailyNotes?.() ?? null;
    } catch (error) {
      console.warn("Failed to read daily notes index", error);
      new Notice("Failed to read daily notes index. Creating today's note.");
    }
    const files = this.extractDailyNoteFiles(allNotes)
      .map((file) => this.normalizeDailyNoteFile(file))
      .filter((file): file is TFile => !!file);
    const latest = this.getLatestNoteByMtime(files);
    if (latest) {
      return latest;
    }
    if (dailyNotesApi.createDailyNote) {
      try {
        const created = await dailyNotesApi.createDailyNote(moment(), settings);
        const normalized = this.normalizeDailyNoteFile(created);
        if (normalized) {
          return normalized;
        }
        new Notice("Daily note file could not be resolved. Using fallback daily note path.");
      } catch (error) {
        console.warn("Failed to create daily note", error);
        new Notice("Failed to create daily note.");
      }
    }

    if (!rawSettings) {
      new Notice("Daily Notes plugin is not configured. Using fallback daily note path.");
    } else if (!dailyNotesApi.createDailyNote) {
      new Notice("Daily Notes plugin is not available. Using fallback daily note path.");
    }

    const fallbackPath = this.buildDailyNotePath(settings, this.formatDailyNoteDate(settings));
    const ensured = await this.ensureDailyNoteFile(fallbackPath);
    if (!ensured) {
      new Notice("Daily note file could not be created.");
      return null;
    }
    return ensured;
  }

  private formatDailyNoteDate(settings: DailyNoteSettings): string {
    const format = settings.format?.trim() ? settings.format.trim() : "YYYY-MM-DD";
    const formatter = moment() as unknown as {
      format?: (format: string) => string;
      toDate?: () => Date;
    };
    if (typeof formatter.format === "function") {
      return formatter.format(format);
    }
    const date = typeof formatter.toDate === "function" ? formatter.toDate() : new Date();
    return this.formatDateWithPattern(date, format);
  }

  private formatDateWithPattern(date: Date, pattern: string): string {
    const year = String(date.getFullYear()).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return pattern
      .replace(/YYYY/g, year)
      .replace(/MM/g, month)
      .replace(/DD/g, day);
  }

  private buildDailyNotePath(settings: DailyNoteSettings, dateString: string): string {
    const folder = settings.folder?.trim() ? settings.folder.trim().replace(/\/+$/, "") : "";
    const name = dateString;
    const filename = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
    return folder ? `${folder}/${filename}` : filename;
  }

  private resolveOverrideDailyNotePath(settings: DailyNoteSettings): string | null {
    const template = this.settings.dailyNotePathTemplate?.trim();
    if (!template) {
      return null;
    }
    const dateString = this.formatDailyNoteDate(settings);
    let path = template.replace(/\{date\}/g, dateString).trim();
    if (!path) {
      return null;
    }
    const hasExtension = /\.[^/]+$/.test(path);
    if (!hasExtension) {
      path = `${path}.md`;
    }
    return path;
  }

  private async ensureDailyNoteFile(path: string): Promise<TFile | null> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      return existing;
    }
    const folderPath = path.split("/").slice(0, -1).join("/");
    if (folderPath) {
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!folder) {
        try {
          await this.app.vault.createFolder(folderPath);
        } catch (error) {
          console.warn("Failed to create daily note folder", error);
          return null;
        }
      }
    }
    try {
      return await this.app.vault.create(path, "");
    } catch (error) {
      console.warn("Failed to create daily note file", error);
      return null;
    }
  }

  private normalizeDailyNoteSettings(settings: DailyNoteSettings | null): DailyNoteSettings | null {
    if (!settings) {
      return null;
    }
    const format = typeof settings.format === "string" && settings.format.trim()
      ? settings.format.trim()
      : "YYYY-MM-DD";
    const folder = typeof settings.folder === "string" ? settings.folder.trim() : undefined;
    const template = typeof settings.template === "string" ? settings.template.trim() : undefined;
    return { format, folder, template };
  }

  private extractDailyNoteFiles(
    notes: Record<string, TFile> | Map<string, TFile> | null
  ): TFile[] {
    if (!notes) {
      return [];
    }
    if (notes instanceof Map) {
      return Array.from(notes.values());
    }
    return Object.values(notes);
  }

  private normalizeDailyNoteFile(candidate: unknown): TFile | null {
    if (!candidate) {
      return null;
    }
    if (candidate instanceof TFile) {
      const resolved = this.app.vault.getAbstractFileByPath(candidate.path);
      return resolved instanceof TFile ? resolved : null;
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const file = this.app.vault.getAbstractFileByPath(candidate.trim());
      return file instanceof TFile ? file : null;
    }
    if (typeof candidate === "object") {
      const path = (candidate as { path?: unknown }).path;
      if (typeof path === "string" && path.trim()) {
        const file = this.app.vault.getAbstractFileByPath(path.trim());
        return file instanceof TFile ? file : null;
      }
    }
    return null;
  }

  private getLatestNoteByMtime(files: TFile[]): TFile | null {
    let latest: TFile | null = null;
    let latestMtime = -1;
    for (const file of files) {
      const mtime = (file as { stat?: { mtime?: number } }).stat?.mtime ?? 0;
      if (!latest || mtime > latestMtime) {
        latest = file;
        latestMtime = mtime;
      }
    }
    return latest;
  }

  private async addTaskFromTelegram(
    messageText: string,
    options: { role: "host" | "guest"; chatId: number | string }
  ): Promise<void> {
    try {
      if (typeof messageText !== "string") {
        new Notice("Telegram message is invalid; cannot add task.");
        return;
      }
      const trimmedMessage = messageText.trim();
      if (!trimmedMessage) {
        new Notice("Telegram message is empty; cannot add task.");
        return;
      }

      const { lineText: baseLineText, cleanedText } = buildTaskLineFromInput(trimmedMessage);
      let lineText = baseLineText;
      const tagsToApply = new Set<string>();
      if (options.role === "guest") {
        tagsToApply.add("#shared");
      }
      const globalTag = normalizeTagFilter(this.settings.globalFilterTag);
      if (globalTag) {
        tagsToApply.add(globalTag);
      }
      const applyTag = (text: string, tag: string): string => {
        const matcher = buildTagMatchRegex(tag);
        if (matcher && matcher.test(text)) {
          return text;
        }
        const prefixMatch = text.match(/^(\s*-\s*\[ \]\s*)(.*)$/);
        if (prefixMatch) {
          return `${prefixMatch[1]}${tag} ${prefixMatch[2]}`.trimEnd();
        }
        return `${tag} ${text}`.trim();
      };
      for (const tag of tagsToApply) {
        lineText = applyTag(lineText, tag);
      }
      const dailyNote = await this.resolveLatestDailyNoteFile();
      if (!dailyNote || !dailyNote.path) {
        const message = "Daily note file not found; cannot add task.";
        new Notice(message);
        await this.safeTelegramCall("send message", () =>
          this.telegramClient.sendMessageTo(options.chatId, message)
        );
        return;
      }

      const contents = await this.app.vault.read(dailyNote);
      const lines = contents ? contents.split("\n") : [];
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }

      const lineIndex = lines.length;
      const id = hashTaskId(`${dailyNote.path}::${lineIndex}::${lineText}`);
      let finalLine = lineText;
      if (this.settings.taskIdTaggingMode === "always") {
        finalLine = ensureTaskIdTagOnLine(finalLine, id);
      }

      lines.push(finalLine);
      await this.app.vault.modify(dailyNote, lines.join("\n"));

      const shortId = id.slice(0, 8);
      await this.safeTelegramCall("send message", () =>
        this.telegramClient.sendMessageTo(options.chatId, `Added task: ${cleanedText} #${shortId}`)
      );
    } catch (error) {
      const reason = error instanceof Error && error.message ? `: ${error.message}` : ".";
      const location = this.describeErrorLocation(error);
      const locationSuffix = location ? ` (${location})` : "";
      new Notice(`Failed to add task from Telegram${reason}${locationSuffix}`);

      const stack = error instanceof Error && error.stack ? error.stack : "";
      const header = `Failed to add task from Telegram${reason}`;
      const details = [
        location ? `Location: ${location}` : null,
        stack ? `Stack:\n${stack}` : null
      ]
        .filter(Boolean)
        .join("\n");
      let message = details ? `${header}\n${details}` : header;
      if (message.length > TELEGRAM_SAFE_MESSAGE_LENGTH) {
        message = `${message.slice(0, TELEGRAM_SAFE_MESSAGE_LENGTH - 3)}...`;
      }

      await this.safeTelegramCall("send message", () =>
        this.telegramClient.sendMessageTo(options.chatId, message)
      );
    }
  }

  private describeErrorLocation(error: unknown): string | null {
    if (!(error instanceof Error)) {
      return null;
    }
    const stack = error.stack;
    if (!stack) {
      return null;
    }
    const lines = stack.split("\n");
    if (lines.length < 2) {
      return null;
    }
    const frame = lines.find((line, index) => index > 0 && line.trim().startsWith("at ")) ?? lines[1];
    const match = frame.match(/\(?([^()]+\.(?:ts|js)(?::\d+){1,2})\)?/);
    return match?.[1] ?? null;
  }

  private async completeTaskById(taskId: string, role: "host" | "guest"): Promise<boolean> {
    const cached = this.taskCache.get(taskId);
    const task = cached ?? (await this.findTaskById(taskId));
    if (!task) {
      new Notice(`Task not found for ID ${taskId}`);
      return false;
    }
    if (role === "guest" && !this.isSharedTask(task)) {
      return false;
    }
    const updated = await this.markTaskComplete(task);
    if (updated) {
      new Notice(`Task marked complete: ${task.text}`);
    }
    return updated;
  }

  private async findTaskById(taskId: string): Promise<TaskRecord | null> {
    const tasks = await this.collectTasks();
    for (const task of tasks) {
      if (task.id === taskId || task.shortId === taskId) {
        return task;
      }
    }
    return null;
  }

  private async markTaskComplete(task: TaskRecord): Promise<boolean> {
    if (!task.path) {
      return false;
    }
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) {
      return false;
    }

    const contents = await this.app.vault.read(file);
    const lines = contents.split("\n");
    const shouldTag = this.settings.taskIdTaggingMode !== "never";
    const idTagRegex = buildTaskIdTagRegexForId(task.id, "i");

    const candidateIndexes: number[] = [];
    if (typeof task.line === "number") {
      candidateIndexes.push(task.line, task.line - 1);
    }

    for (const index of candidateIndexes) {
      if (index < 0 || index >= lines.length) {
        continue;
      }
      if (!matchesTaskLine(lines[index], task, false)) {
        continue;
      }
      const updated = replaceCheckbox(lines[index]);
      if (updated) {
        const nextLine = shouldTag && !hasTaskIdTag(updated)
          ? ensureTaskIdTagOnLine(updated, task.id)
          : updated;
        lines[index] = nextLine;
        await this.app.vault.modify(file, lines.join("\n"));
        return true;
      }
    }

    for (let i = 0; i < lines.length; i += 1) {
      if (idTagRegex.test(lines[i]) && isTaskLine(lines[i])) {
        const updated = replaceCheckbox(lines[i]);
        if (updated) {
          const nextLine = shouldTag && !hasTaskIdTag(updated)
            ? ensureTaskIdTagOnLine(updated, task.id)
            : updated;
          lines[i] = nextLine;
          await this.app.vault.modify(file, lines.join("\n"));
          return true;
        }
      }
      if (!matchesTaskLine(lines[i], task, false)) {
        continue;
      }
      const updated = replaceCheckbox(lines[i]);
      if (updated) {
        const nextLine = shouldTag && !hasTaskIdTag(updated)
          ? ensureTaskIdTagOnLine(updated, task.id)
          : updated;
        lines[i] = nextLine;
        await this.app.vault.modify(file, lines.join("\n"));
        return true;
      }
    }

    return false;
  }
}

class TelegramTasksNotifierSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: TelegramTasksNotifierPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Telegram Tasks Notifier" });

    new Setting(containerEl)
      .setName("Tasks query")
      .setDesc("Tasks plugin query used to fetch unfinished tasks.")
      .addText((text) =>
        text
          .setPlaceholder("not done")
          .setValue(this.plugin.settings.tasksQuery)
          .onChange(async (value) => {
            this.plugin.settings.tasksQuery = value;
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Global filter tag")
      .setDesc("Only include tasks that have this tag (e.g. #work).")
      .addText((text) =>
        text
          .setPlaceholder("#work")
          .setValue(this.plugin.settings.globalFilterTag)
          .onChange(async (value) => {
            this.plugin.settings.globalFilterTag = value.trim();
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Daily note path override")
      .setDesc("Optional file path for incoming Telegram tasks. Use {date} to insert the daily note date.")
      .addText((text) =>
        text
          .setPlaceholder("Daily/{date}.md")
          .setValue(this.plugin.settings.dailyNotePathTemplate)
          .onChange(async (value) => {
            this.plugin.settings.dailyNotePathTemplate = value.trim();
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Telegram bot token")
      .setDesc("Bot token from BotFather.")
      .addText((text) =>
        text
          .setPlaceholder("123456:ABC-DEF...")
          .setValue(this.plugin.settings.botToken)
          .onChange(async (value) => {
            this.plugin.settings.botToken = value.trim();
             await this.plugin.saveSettingsAndReconfigure();
           })
       );

    new Setting(containerEl)
      .setName("Host chat ID")
      .setDesc("Chat ID for the host (full access).")
      .addText((text) =>
        text
          .setPlaceholder("123456789")
          .setValue(this.plugin.settings.hostChatId)
          .onChange(async (value) => {
            this.plugin.settings.hostChatId = value.trim();
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Guest chat IDs")
      .setDesc("Comma-separated chat IDs that can access #shared tasks.")
      .addText((text) =>
        text
          .setPlaceholder("123456789, 987654321")
          .setValue(formatChatIds(this.plugin.settings.guestChatIds))
          .onChange(async (value) => {
            this.plugin.settings.guestChatIds = parseChatIds(value);
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Requestors")
      .setDesc("Chat IDs that sent /start (editable).")
      .addText((text) =>
        text
          .setPlaceholder("123456789, 987654321")
          .setValue(formatChatIds(this.plugin.settings.requestors))
          .onChange(async (value) => {
            this.plugin.settings.requestors = parseChatIds(value);
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Allowed Telegram user IDs")
      .setDesc("Optional comma-separated user IDs allowed to mark tasks complete.")
      .addText((text) =>
        text
          .setPlaceholder("123456, 789012")
          .setValue(formatAllowedUserIds(this.plugin.settings.allowedTelegramUserIds))
          .onChange(async (value) => {
            this.plugin.settings.allowedTelegramUserIds = parseAllowedUserIds(value);
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Task ID tagging mode")
      .setDesc("Controls when #taskid tags are written to task lines.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("always", "Always")
          .addOption("on-complete", "Only on completion")
          .addOption("never", "Never")
          .setValue(this.plugin.settings.taskIdTaggingMode)
          .onChange(async (value) => {
            this.plugin.settings.taskIdTaggingMode = value as TaskIdTaggingMode;
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Notify on startup")
      .setDesc("Send tasks notification when Obsidian starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.notifyOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.notifyOnStartup = value;
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Notification interval (minutes)")
      .setDesc("Set to 0 to disable periodic notifications.")
      .addText((text) =>
        text
          .setPlaceholder("60")
          .setValue(String(this.plugin.settings.notificationIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.notificationIntervalMinutes = Number.isFinite(parsed) ? parsed : 0;
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Poll Telegram updates")
      .setDesc("Enable polling for reactions to mark tasks complete.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableTelegramPolling)
          .onChange(async (value) => {
            this.plugin.settings.enableTelegramPolling = value;
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Polling interval (seconds)")
      .setDesc("How long Telegram long-polls for updates.")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.pollIntervalSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.pollIntervalSeconds = Number.isFinite(parsed) ? parsed : 10;
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Max tasks per notification")
      .setDesc("Limits the number of tasks shown in one Telegram message.")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.maxTasksPerNotification))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.maxTasksPerNotification = Number.isFinite(parsed) ? parsed : 20;
            await this.plugin.saveSettingsAndReconfigure();
          })
      );

    new Setting(containerEl)
      .setName("Include file path")
      .setDesc("Include file path and line number in each task line.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeFilePath)
          .onChange(async (value) => {
            this.plugin.settings.includeFilePath = value;
            await this.plugin.saveSettingsAndReconfigure();
          })
      );
  }
}
