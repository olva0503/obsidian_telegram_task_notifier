import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl
} from "obsidian";

type TasksApi = {
  getTasks?: (query: string) => Promise<unknown[]> | unknown[];
  getTasksFromQuery?: (query: string) => Promise<unknown[]> | unknown[];
  queryTasks?: (query: string) => Promise<unknown[]> | unknown[];
};

type TaskRecord = {
  id: string;
  shortId: string;
  text: string;
  path: string | null;
  line: number | null;
  raw: string | null;
  priority: number;
  dueTimestamp: number | null;
};

type TelegramUpdate = {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; username?: string };
    message?: { message_id: number; chat?: { id: number } };
  };
  message?: {
    text?: string;
    chat?: { id: number };
    from?: { id: number; username?: string };
  };
};

interface TelegramTasksNotifierSettings {
  botToken: string;
  chatId: string;
  tasksQuery: string;
  globalFilterTag: string;
  notifyOnStartup: boolean;
  notificationIntervalMinutes: number;
  pollIntervalSeconds: number;
  maxTasksPerNotification: number;
  includeFilePath: boolean;
  enableTelegramPolling: boolean;
  lastUpdateId: number;
}

const DEFAULT_SETTINGS: TelegramTasksNotifierSettings = {
  botToken: "",
  chatId: "",
  tasksQuery: "not done",
  globalFilterTag: "",
  notifyOnStartup: true,
  notificationIntervalMinutes: 60,
  pollIntervalSeconds: 10,
  maxTasksPerNotification: 20,
  includeFilePath: true,
  enableTelegramPolling: true,
  lastUpdateId: 0
};

class TelegramClient {
  constructor(private readonly plugin: TelegramTasksNotifierPlugin) {}

  private get apiBase(): string {
    const token = this.plugin.settings.botToken.trim();
    return `https://api.telegram.org/bot${token}`;
  }

  async sendMessage(text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
    const chatId = this.plugin.settings.chatId.trim();
    await requestUrl({
      url: `${this.apiBase}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: replyMarkup
      })
    });
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const response = await requestUrl({
      url: `${this.apiBase}/getUpdates`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset,
        timeout: 0,
        allowed_updates: ["message", "callback_query"]
      })
    });
    const data = response.json as { ok: boolean; result: TelegramUpdate[] };
    return data?.result ?? [];
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await requestUrl({
      url: `${this.apiBase}/answerCallbackQuery`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: id,
        text
      })
    });
  }
}

export default class TelegramTasksNotifierPlugin extends Plugin {
  settings: TelegramTasksNotifierSettings;
  private telegramClient: TelegramClient;
  private notificationIntervalId: number | null = null;
  private pollingIntervalId: number | null = null;
  private taskCache = new Map<string, TaskRecord>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.telegramClient = new TelegramClient(this);

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
      this.pollingIntervalId = window.setInterval(() => {
        void this.pollTelegramUpdates();
      }, this.settings.pollIntervalSeconds * 1000);
    }
  }

  private clearIntervals(): void {
    if (this.notificationIntervalId !== null) {
      window.clearInterval(this.notificationIntervalId);
      this.notificationIntervalId = null;
    }
    if (this.pollingIntervalId !== null) {
      window.clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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

  private normalizeTasksQuery(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      return "";
    }
    if (trimmed.startsWith("```")) {
      const lines = trimmed.split(/\r?\n/);
      const firstLine = lines[0].replace(/^```/, "").trim();
      const contentLines = lines.slice(1);
      if (contentLines.length > 0) {
        const lastLine = contentLines[contentLines.length - 1].trim();
        if (lastLine.startsWith("```")) {
          contentLines.pop();
        }
      }
      if (/^tasks\b/i.test(firstLine)) {
        const afterTasks = firstLine.replace(/^tasks\b/i, "").trim();
        if (afterTasks) {
          contentLines.unshift(afterTasks);
        }
      }
      return contentLines.join("\n").trim();
    }
    if (/^tasks\s+/i.test(trimmed)) {
      return trimmed.replace(/^tasks\s+/i, "").trim();
    }
    return trimmed;
  }

  private normalizeTagFilter(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  }

  private buildTagMatchRegex(tag: string): RegExp | null {
    const normalized = this.normalizeTagFilter(tag);
    if (!normalized) {
      return null;
    }
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$|[.,;:!?])`, "i");
  }

  private taskMatchesGlobalTag(task: Record<string, unknown>, record: TaskRecord): boolean {
    const tag = this.normalizeTagFilter(this.settings.globalFilterTag);
    if (!tag) {
      return true;
    }
    const lowerTag = tag.toLowerCase();
    const tags = (task as { tags?: unknown }).tags;
    if (Array.isArray(tags)) {
      const matchesArray = tags.some((entry) => {
        if (typeof entry !== "string") {
          return false;
        }
        const normalized = this.normalizeTagFilter(entry).toLowerCase();
        return normalized === lowerTag;
      });
      if (matchesArray) {
        return true;
      }
    }
    const raw = record.raw ?? this.getTaskRaw(task) ?? "";
    const text = record.text ?? this.getTaskText(task) ?? "";
    const matcher = this.buildTagMatchRegex(tag);
    if (!matcher) {
      return true;
    }
    return matcher.test(raw) || matcher.test(text);
  }

  private async queryTasksFromApi(api: TasksApi): Promise<unknown[] | null> {
    const query = this.normalizeTasksQuery(this.settings.tasksQuery);
    const queryFn = api.getTasks ?? api.getTasksFromQuery ?? api.queryTasks;
    if (!queryFn) {
      new Notice("Tasks plugin API does not expose a query method.");
      return null;
    }
    const normalize = (result: unknown): unknown[] => {
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
    };

    try {
      const result = await queryFn.call(api, query);
      const tasks = normalize(result);
      if (tasks.length > 0 || query.length === 0) {
        return tasks;
      }
    } catch (error) {
      console.warn("Failed Tasks query with string", error);
    }

    try {
      const result = await queryFn.call(api, { query });
      return normalize(result);
    } catch (error) {
      console.warn("Failed Tasks query with object", error);
      return null;
    }
  }

  private isTaskCompleted(task: Record<string, unknown>): boolean {
    if (task.completed === true || task.isCompleted === true) {
      return true;
    }
    const status = task.status as { type?: string; isCompleted?: boolean } | undefined;
    if (status?.isCompleted === true) {
      return true;
    }
    if (typeof status?.type === "string" && status.type.toLowerCase() === "done") {
      return true;
    }
    const raw = this.getTaskRaw(task);
    if (raw && /\[[xX]\]/.test(raw)) {
      return true;
    }
    return false;
  }

  private getTaskText(task: Record<string, unknown>): string {
    return (
      (task.description as string) ||
      (task.text as string) ||
      (task.task as string) ||
      (task.content as string) ||
      this.getTaskRaw(task) ||
      "(unnamed task)"
    );
  }

  private getTaskRaw(task: Record<string, unknown>): string | null {
    return (
      (task.originalMarkdown as string) ||
      (task.raw as string) ||
      (task.lineText as string) ||
      null
    );
  }

  private getTaskPath(task: Record<string, unknown>): string | null {
    return (
      (task.path as string) ||
      (task.filePath as string) ||
      ((task.file as { path?: string } | undefined)?.path ?? null)
    );
  }

  private getTaskLine(task: Record<string, unknown>): number | null {
    const line =
      (task.line as number) ??
      (task.lineNumber as number) ??
      (task.position as { start?: { line?: number } } | undefined)?.start?.line ??
      null;
    return Number.isFinite(line) ? Number(line) : null;
  }

  private normalizePriority(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value <= 0) {
        return 0;
      }
      if (value >= 4) {
        return 4;
      }
      return Math.round(value);
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["highest", "urgent", "top"].includes(normalized)) {
        return 4;
      }
      if (["high"].includes(normalized)) {
        return 3;
      }
      if (["medium", "normal", "default"].includes(normalized)) {
        return 2;
      }
      if (["low"].includes(normalized)) {
        return 1;
      }
      if (["lowest", "none"].includes(normalized)) {
        return 0;
      }
    }
    if (typeof value === "object") {
      const record = value as {
        name?: unknown;
        label?: unknown;
        id?: unknown;
        value?: unknown;
        priority?: unknown;
      };
      return (
        this.normalizePriority(record.value) ??
        this.normalizePriority(record.priority) ??
        this.normalizePriority(record.id) ??
        this.normalizePriority(record.name) ??
        this.normalizePriority(record.label)
      );
    }
    return null;
  }

  private parsePriorityFromRaw(raw: string | null): number | null {
    if (!raw) {
      return null;
    }
    if (raw.includes("\u23EB")) {
      return 4;
    }
    if (raw.includes("\uD83D\uDD3C")) {
      return 3;
    }
    if (raw.includes("\uD83D\uDD3D")) {
      return 1;
    }
    if (raw.includes("\u23EC")) {
      return 0;
    }
    const keywordMatch = raw.match(/\bpriority[:\s]*([a-zA-Z]+)\b/i);
    if (keywordMatch) {
      return this.normalizePriority(keywordMatch[1]);
    }
    return null;
  }

  private getTaskPriority(task: Record<string, unknown>): number {
    const fromField =
      this.normalizePriority(task.priority) ??
      this.normalizePriority((task as { priorityNumber?: unknown }).priorityNumber) ??
      this.normalizePriority((task as { priorityValue?: unknown }).priorityValue) ??
      this.normalizePriority((task as { urgency?: unknown }).urgency);
    if (fromField !== null) {
      return fromField;
    }
    const fromRaw = this.parsePriorityFromRaw(this.getTaskRaw(task));
    return fromRaw ?? 0;
  }

  private parseDateString(value: string): number | null {
    const isoMatch = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (isoMatch) {
      const year = Number.parseInt(isoMatch[1], 10);
      const month = Number.parseInt(isoMatch[2], 10);
      const day = Number.parseInt(isoMatch[3], 10);
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        return Date.UTC(year, month - 1, day);
      }
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private normalizeDueTimestamp(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1_000_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string") {
      return this.parseDateString(value);
    }
    if (typeof value === "object") {
      const record = value as {
        toMillis?: () => number;
        toJSDate?: () => Date;
        toISO?: () => string;
        year?: unknown;
        month?: unknown;
        day?: unknown;
        date?: unknown;
      };
      if (typeof record.toMillis === "function") {
        const millis = record.toMillis();
        return Number.isFinite(millis) ? millis : null;
      }
      if (typeof record.toJSDate === "function") {
        const date = record.toJSDate();
        return date instanceof Date ? date.getTime() : null;
      }
      if (typeof record.toISO === "function") {
        return this.parseDateString(record.toISO());
      }
      if (
        typeof record.year === "number" &&
        typeof record.month === "number" &&
        typeof record.day === "number"
      ) {
        return Date.UTC(record.year, record.month - 1, record.day);
      }
      if (typeof record.date === "string") {
        return this.parseDateString(record.date);
      }
    }
    return null;
  }

  private parseDueFromRaw(raw: string | null): number | null {
    if (!raw) {
      return null;
    }
    const emojiMatch = raw.match(/\uD83D\uDCC5\s*(\d{4}-\d{2}-\d{2})/);
    if (emojiMatch) {
      return this.parseDateString(emojiMatch[1]);
    }
    const dueMatch = raw.match(/\bdue[:\s]*([0-9]{4}-[0-9]{2}-[0-9]{2})\b/i);
    if (dueMatch) {
      return this.parseDateString(dueMatch[1]);
    }
    return null;
  }

  private getTaskDueTimestamp(task: Record<string, unknown>): number | null {
    const candidates = [
      (task as { dueDate?: unknown }).dueDate,
      (task as { due?: unknown }).due,
      (task as { dueOn?: unknown }).dueOn,
      (task as { dueDateTime?: unknown }).dueDateTime,
      (task as { dueAt?: unknown }).dueAt,
      (task as { dueDateString?: unknown }).dueDateString,
      (task as { dates?: { due?: unknown } }).dates?.due
    ];
    for (const candidate of candidates) {
      const normalized = this.normalizeDueTimestamp(candidate);
      if (normalized !== null) {
        return normalized;
      }
    }
    return this.parseDueFromRaw(this.getTaskRaw(task));
  }

  private toTaskRecord(task: Record<string, unknown>): TaskRecord {
    const text = this.getTaskText(task);
    const path = this.getTaskPath(task);
    const line = this.getTaskLine(task);
    const raw = this.getTaskRaw(task);
    const priority = this.getTaskPriority(task);
    const dueTimestamp = this.getTaskDueTimestamp(task);
    const id = this.hashTaskId(`${path ?? ""}::${line ?? ""}::${raw ?? text}`);
    const shortId = id.slice(0, 8);
    return { id, shortId, text, path, line, raw, priority, dueTimestamp };
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

  private hashTaskId(input: string): string {
    let hash = 5381;
    for (let i = 0; i < input.length; i += 1) {
      hash = (hash * 33) ^ input.charCodeAt(i);
    }
    return (hash >>> 0).toString(16).padStart(8, "0") + input.length.toString(16);
  }

  private async collectTasks(): Promise<TaskRecord[]> {
    const api = this.getTasksApi();
    if (!api) {
      const tasks = await this.collectTasksFromVault();
      return this.sortTasks(tasks);
    }

    const tasks = await this.queryTasksFromApi(api);
    if (tasks === null) {
      const tasks = await this.collectTasksFromVault();
      return this.sortTasks(tasks);
    }

    const records = tasks
      .filter((task) => !this.isTaskCompleted(task as Record<string, unknown>))
      .map((task) => {
        const record = this.toTaskRecord(task as Record<string, unknown>);
        return { task: task as Record<string, unknown>, record };
      })
      .filter(({ task, record }) => this.taskMatchesGlobalTag(task, record))
      .map(({ record }) => record);
    return this.sortTasks(records);
  }

  private async collectTasksFromVault(): Promise<TaskRecord[]> {
    const records: TaskRecord[] = [];
    const files = this.app.vault.getMarkdownFiles();
    const taskRegex = /^\s*-\s*\[ \]\s*(.*)$/;
    const tagRegex = this.buildTagMatchRegex(this.settings.globalFilterTag);

    for (const file of files) {
      const contents = await this.app.vault.read(file);
      const lines = contents.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const lineText = lines[i];
        const match = lineText.match(taskRegex);
        if (!match) {
          continue;
        }
        if (tagRegex && !tagRegex.test(lineText)) {
          continue;
        }
        const text = match[1]?.trim() || "(unnamed task)";
        const id = this.hashTaskId(`${file.path}::${i}::${lineText}`);
        const shortId = id.slice(0, 8);
        const priority = this.parsePriorityFromRaw(lineText) ?? 0;
        const dueTimestamp = this.parseDueFromRaw(lineText);
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
    }

    return records;
  }

  async sendTasksNotification(): Promise<void> {
    const tasks = await this.collectTasks();
    await this.sendTasksNotificationWithTasks(tasks);
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

  private async sendTasksNotificationWithTasks(tasks: TaskRecord[]): Promise<void> {
    if (!this.settings.botToken.trim() || !this.settings.chatId.trim()) {
      new Notice("Telegram bot token or chat ID is missing.");
      return;
    }

    this.taskCache.clear();
    tasks.forEach((task) => this.taskCache.set(task.id, task));

    if (tasks.length === 0) {
      new Notice("No unfinished tasks found.");
      return;
    }

    const maxTasks = Math.max(1, this.settings.maxTasksPerNotification);
    const shownTasks = tasks.slice(0, maxTasks);
    const header = `Unfinished tasks: ${tasks.length}`;
    const lines = shownTasks.map((task) => {
      const location = this.settings.includeFilePath && task.path
        ? ` (${task.path}${task.line !== null ? ":" + task.line : ""})`
        : "";
      return `- ${task.text}${location} #${task.shortId}`;
    });
    const footer = tasks.length > shownTasks.length
      ? `...and ${tasks.length - shownTasks.length} more`
      : "";
    const message = [header, "", ...lines, footer].filter(Boolean).join("\n");

    const replyMarkup = {
      inline_keyboard: shownTasks.map((task) => [
        {
          text: `Done #${task.shortId}`,
          callback_data: `done:${task.id}`
        }
      ])
    };

    await this.telegramClient.sendMessage(message, replyMarkup);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private async pollTelegramUpdates(): Promise<void> {
    if (!this.settings.enableTelegramPolling) {
      return;
    }
    if (!this.settings.botToken.trim() || !this.settings.chatId.trim()) {
      return;
    }
    const offset = this.settings.lastUpdateId + 1;
    const updates = await this.telegramClient.getUpdates(offset);
    if (updates.length === 0) {
      return;
    }

    let latestUpdateId = this.settings.lastUpdateId;
    for (const update of updates) {
      latestUpdateId = Math.max(latestUpdateId, update.update_id);

      if (update.callback_query?.data?.startsWith("done:")) {
        const taskId = update.callback_query.data.slice("done:".length);
        const success = await this.completeTaskById(taskId);
        await this.telegramClient.answerCallbackQuery(
          update.callback_query.id,
          success ? "Task marked complete" : "Task not found"
        );
        continue;
      }

      const messageText = update.message?.text ?? "";
      const chatId = update.message?.chat?.id;
      if (chatId && String(chatId) === this.settings.chatId.trim()) {
        const match = messageText.match(/^\s*done\s+([a-f0-9]+)\s*$/i);
        if (match) {
          await this.completeTaskById(match[1]);
        }
      }
    }

    this.settings.lastUpdateId = latestUpdateId;
    await this.saveSettings();
  }

  async detectTelegramChatId(): Promise<void> {
    if (!this.settings.botToken.trim()) {
      new Notice("Telegram bot token is missing.");
      return;
    }

    const updates = await this.telegramClient.getUpdates(0);
    if (updates.length === 0) {
      new Notice("No Telegram updates found. Send /start to the bot first.");
      return;
    }

    let latestUpdateId = this.settings.lastUpdateId;
    let detectedChatId: number | null = null;

    for (const update of updates) {
      latestUpdateId = Math.max(latestUpdateId, update.update_id);
      const chatId =
        update.message?.chat?.id ??
        update.callback_query?.message?.chat?.id ??
        null;
      if (chatId !== null) {
        detectedChatId = chatId;
      }
    }

    if (detectedChatId === null) {
      new Notice("No chat ID found in updates.");
      return;
    }

    this.settings.chatId = String(detectedChatId);
    this.settings.lastUpdateId = latestUpdateId;
    await this.saveSettings();
    new Notice(`Telegram chat ID set to ${detectedChatId}`);
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

    const candidateIndexes: number[] = [];
    if (typeof task.line === "number") {
      candidateIndexes.push(task.line, task.line - 1);
    }

    const matchesTaskLine = (lineText: string): boolean => {
      if (task.raw && lineText.includes(task.raw)) {
        return true;
      }
      if (task.text && lineText.includes(task.text)) {
        return true;
      }
      return false;
    };

    const replaceCheckbox = (lineText: string): string | null => {
      if (!/\[[^\]]\]/.test(lineText)) {
        return null;
      }
      const updated = lineText.replace(/\[[^\]]\]/, "[x]");
      return updated === lineText ? null : updated;
    };

    for (const index of candidateIndexes) {
      if (index < 0 || index >= lines.length) {
        continue;
      }
      if (!matchesTaskLine(lines[index]) && task.raw) {
        continue;
      }
      const updated = replaceCheckbox(lines[index]);
      if (updated) {
        lines[index] = updated;
        await this.app.vault.modify(file, lines.join("\n"));
        return true;
      }
    }

    for (let i = 0; i < lines.length; i += 1) {
      if (!matchesTaskLine(lines[i])) {
        continue;
      }
      const updated = replaceCheckbox(lines[i]);
      if (updated) {
        lines[i] = updated;
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Polling interval (seconds)")
      .setDesc("How often to poll Telegram for updates.")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.pollIntervalSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.pollIntervalSeconds = Number.isFinite(parsed) ? parsed : 10;
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
          })
      );
  }
}
