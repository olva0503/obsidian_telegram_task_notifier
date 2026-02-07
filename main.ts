import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile
} from "obsidian";
import {
  buildTagMatchRegex,
  ensureTaskIdTagOnLine,
  formatTaskTextForMessage,
  getUncheckedTaskText,
  hasTaskIdTag,
  isTaskLine,
  isTaskCompleted,
  isTaskLike,
  matchesTaskLine,
  normalizeTasksQuery,
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
  formatAllowedUserIds,
  parseAllowedUserIds,
  type TaskIdTaggingMode,
  type TelegramTasksNotifierSettings
} from "./settings";
import { TelegramClient, type TelegramUpdate } from "./telegram";
import { buildTaskIdTagRegexForId, getStoredTaskId, hashTaskId } from "./task-id";

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
      name: "Detect Telegram chat ID",
      callback: async () => {
        await this.detectTelegramChatId();
      }
    });

    this.configureIntervals();
    void this.maybeDetectTelegramChatId();

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

  async maybeDetectTelegramChatId(): Promise<void> {
    if (!this.settings.botToken.trim()) {
      return;
    }
    if (this.settings.chatId.trim()) {
      return;
    }
    await this.detectTelegramChatId();
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
    if (!this.settings.botToken.trim() || !this.settings.chatId.trim()) {
      new Notice("Telegram bot token or chat ID is missing.");
      return;
    }

    this.taskCache.clear();
    tasks.forEach((task) => this.taskCache.set(task.id, task));

    if (tasks.length === 0) {
      if (options.allowEmpty) {
        await this.safeTelegramCall("send message", () =>
          this.telegramClient.sendMessage("No unfinished tasks found.")
        );
      } else {
        new Notice("No unfinished tasks found.");
      }
      return;
    }

    const maxTasks = Math.max(1, this.settings.maxTasksPerNotification);
    const shownTasks = tasks.slice(0, maxTasks);
    const tagMatcher = buildTagMatchRegex(this.settings.globalFilterTag);
    const header = `Unfinished tasks: ${tasks.length}`;
    const lines = shownTasks.map((task) => {
      const location = this.settings.includeFilePath && task.path
        ? ` (${task.path}${task.line !== null ? ":" + (task.line + 1) : ""})`
        : "";
      return `- ${formatTaskTextForMessage(task.text, tagMatcher)}${location} #${task.shortId}`;
    });
    const footer = tasks.length > shownTasks.length
      ? `...and ${tasks.length - shownTasks.length} more`
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
      const sent = await this.safeTelegramCall("send message", () => this.telegramClient.sendMessage(text, markup));
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

  private isAllowedChatId(chatId: number | undefined | null): boolean {
    const configured = this.settings.chatId.trim();
    if (!configured || chatId === undefined || chatId === null) {
      return false;
    }
    return String(chatId) === configured;
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
    return this.isAllowedChatId(chatId) && this.isAllowedTelegramUser(userId);
  }

  private async pollTelegramUpdates(): Promise<void> {
    if (!this.settings.enableTelegramPolling) {
      return;
    }
    if (!this.settings.botToken.trim() || !this.settings.chatId.trim()) {
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

          if (!this.isAuthorizedUpdate(callbackChatId, callbackUserId)) {
            await this.safeTelegramCall("answer callback query", () =>
              this.telegramClient.answerCallbackQuery(callback.id, "Unauthorized")
            );
            continue;
          }

          const tasks = await this.collectTasks();
          await this.sendTasksNotificationWithTasks(tasks, { allowEmpty: true });
          await this.safeTelegramCall("answer callback query", () =>
            this.telegramClient.answerCallbackQuery(callback.id, "Sent task list")
          );
          continue;
        }

        if (callback?.data?.startsWith("done:")) {
          const taskId = callback.data.slice("done:".length);
          const callbackChatId = callback.message?.chat?.id;
          const callbackUserId = callback.from?.id;

          if (!this.isAuthorizedUpdate(callbackChatId, callbackUserId)) {
            await this.safeTelegramCall("answer callback query", () =>
              this.telegramClient.answerCallbackQuery(callback.id, "Unauthorized")
            );
            continue;
          }

          const success = await this.completeTaskById(taskId);
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
        if (!this.isAuthorizedUpdate(chatId, userId)) {
          continue;
        }

        const listMatch = messageText.match(/^\s*\/list(?:@\S+)?\s*$/i);
        if (listMatch) {
          const tasks = await this.collectTasks();
          await this.sendTasksNotificationWithTasks(tasks, { allowEmpty: true });
          continue;
        }

        const doneMatch = messageText.match(/^\s*done\s+([a-f0-9]+)\s*$/i);
        if (doneMatch) {
          await this.completeTaskById(doneMatch[1]);
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

    this.settings.chatId = String(resolvedChatId);
    this.settings.lastUpdateId = latestUpdateId;
    await this.saveSettings();
    new Notice(`Telegram chat ID set to ${resolvedChatId}`);
  }

  private async completeTaskById(taskId: string): Promise<boolean> {
    const cached = this.taskCache.get(taskId);
    const task = cached ?? (await this.findTaskById(taskId));
    if (!task) {
      new Notice(`Task not found for ID ${taskId}`);
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
      .setName("Telegram bot token")
      .setDesc("Bot token from BotFather.")
      .addText((text) =>
        text
          .setPlaceholder("123456:ABC-DEF...")
          .setValue(this.plugin.settings.botToken)
          .onChange(async (value) => {
            this.plugin.settings.botToken = value.trim();
            await this.plugin.saveSettingsAndReconfigure();
            await this.plugin.maybeDetectTelegramChatId();
          })
      );

    new Setting(containerEl)
      .setName("Telegram chat ID")
      .setDesc("Chat ID where notifications are sent.")
      .addText((text) =>
        text
          .setPlaceholder("123456789")
          .setValue(this.plugin.settings.chatId)
          .onChange(async (value) => {
            this.plugin.settings.chatId = value.trim();
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
