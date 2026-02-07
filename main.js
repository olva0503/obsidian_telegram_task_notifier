var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => TelegramTasksNotifierPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
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
var TelegramClient = class {
  constructor(plugin) {
    this.plugin = plugin;
  }
  get apiBase() {
    const token = this.plugin.settings.botToken.trim();
    return `https://api.telegram.org/bot${token}`;
  }
  async sendMessage(text, replyMarkup) {
    const chatId = this.plugin.settings.chatId.trim();
    await (0, import_obsidian.requestUrl)({
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
  async getUpdates(offset) {
    var _a;
    const response = await (0, import_obsidian.requestUrl)({
      url: `${this.apiBase}/getUpdates`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset,
        timeout: 0,
        allowed_updates: ["message", "callback_query"]
      })
    });
    const data = response.json;
    return (_a = data == null ? void 0 : data.result) != null ? _a : [];
  }
  async answerCallbackQuery(id, text) {
    await (0, import_obsidian.requestUrl)({
      url: `${this.apiBase}/answerCallbackQuery`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: id,
        text
      })
    });
  }
};
var TelegramTasksNotifierPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.notificationIntervalId = null;
    this.pollingIntervalId = null;
    this.taskCache = /* @__PURE__ */ new Map();
    this.taskIdTagPrefix = "#taskid/";
  }
  async onload() {
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
  onunload() {
    this.clearIntervals();
  }
  configureIntervals() {
    this.clearIntervals();
    if (this.settings.notificationIntervalMinutes > 0) {
      this.notificationIntervalId = window.setInterval(() => {
        void this.sendTasksNotification();
      }, this.settings.notificationIntervalMinutes * 60 * 1e3);
    }
    if (this.settings.enableTelegramPolling && this.settings.pollIntervalSeconds > 0) {
      this.pollingIntervalId = window.setInterval(() => {
        void this.pollTelegramUpdates();
      }, this.settings.pollIntervalSeconds * 1e3);
    }
  }
  clearIntervals() {
    if (this.notificationIntervalId !== null) {
      window.clearInterval(this.notificationIntervalId);
      this.notificationIntervalId = null;
    }
    if (this.pollingIntervalId !== null) {
      window.clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.configureIntervals();
  }
  async maybeDetectTelegramChatId() {
    if (!this.settings.botToken.trim()) {
      return;
    }
    if (this.settings.chatId.trim()) {
      return;
    }
    await this.detectTelegramChatId();
  }
  getTasksApi() {
    var _a, _b, _c;
    const plugin = (_b = (_a = this.app.plugins) == null ? void 0 : _a.plugins) == null ? void 0 : _b["obsidian-tasks-plugin"];
    return (_c = plugin == null ? void 0 : plugin.apiV1) != null ? _c : null;
  }
  normalizeTasksQuery(input) {
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
  normalizeTagFilter(value) {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  }
  buildTagMatchRegex(tag) {
    const normalized = this.normalizeTagFilter(tag);
    if (!normalized) {
      return null;
    }
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$|[.,;:!?])`, "i");
  }
  formatTaskTextForMessage(text) {
    const cleanedTaskId = this.stripTaskIdTag(text);
    const matcher = this.buildTagMatchRegex(this.settings.globalFilterTag);
    if (!matcher) {
      return cleanedTaskId;
    }
    const cleaned = cleanedTaskId.replace(matcher, " ").replace(/\s{2,}/g, " ").trim();
    return cleaned || cleanedTaskId;
  }
  buildTaskIdTagRegex(flags = "i") {
    return new RegExp(`(^|\\s)${this.taskIdTagPrefix.replace("/", "\\/")}[0-9a-f]+(?=\\s|$|[.,;:!?])`, flags);
  }
  getStoredTaskId(text) {
    if (!text) {
      return null;
    }
    const match = text.match(this.buildTaskIdTagRegex("i"));
    if (!match) {
      return null;
    }
    const idMatch = match[0].match(/[0-9a-f]+/i);
    return idMatch ? idMatch[0].toLowerCase() : null;
  }
  stripTaskIdTag(text) {
    const cleaned = text.replace(this.buildTaskIdTagRegex("gi"), " ").replace(/\s{2,}/g, " ").trim();
    return cleaned || text;
  }
  ensureTaskIdTag(lineText, id) {
    if (this.buildTaskIdTagRegex("i").test(lineText)) {
      return lineText;
    }
    const suffix = lineText.endsWith(" ") ? "" : " ";
    return `${lineText}${suffix}${this.taskIdTagPrefix}${id.toLowerCase()}`;
  }
  taskMatchesGlobalTag(task, record) {
    var _a, _b, _c, _d;
    const tag = this.normalizeTagFilter(this.settings.globalFilterTag);
    if (!tag) {
      return true;
    }
    const lowerTag = tag.toLowerCase();
    const tags = task.tags;
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
    const raw = (_b = (_a = record.raw) != null ? _a : this.getTaskRaw(task)) != null ? _b : "";
    const text = (_d = (_c = record.text) != null ? _c : this.getTaskText(task)) != null ? _d : "";
    const matcher = this.buildTagMatchRegex(tag);
    if (!matcher) {
      return true;
    }
    return matcher.test(raw) || matcher.test(text);
  }
  async queryTasksFromApi(api) {
    var _a, _b;
    const query = this.normalizeTasksQuery(this.settings.tasksQuery);
    const queryFn = (_b = (_a = api.getTasks) != null ? _a : api.getTasksFromQuery) != null ? _b : api.queryTasks;
    if (!queryFn) {
      return null;
    }
    const normalize = (result) => {
      if (Array.isArray(result)) {
        return result;
      }
      if (result && typeof result === "object") {
        const maybeTasks = result.tasks;
        if (Array.isArray(maybeTasks)) {
          return maybeTasks;
        }
        const maybeItems = result.items;
        if (Array.isArray(maybeItems)) {
          return maybeItems;
        }
        const maybeResults = result.results;
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
  isTaskCompleted(task) {
    if (task.completed === true || task.isCompleted === true) {
      return true;
    }
    const status = task.status;
    if ((status == null ? void 0 : status.isCompleted) === true) {
      return true;
    }
    if (typeof (status == null ? void 0 : status.type) === "string" && status.type.toLowerCase() === "done") {
      return true;
    }
    const raw = this.getTaskRaw(task);
    if (raw && /\[[xX]\]/.test(raw)) {
      return true;
    }
    return false;
  }
  getTaskText(task) {
    return task.description || task.text || task.task || task.content || this.getTaskRaw(task) || "(unnamed task)";
  }
  getTaskRaw(task) {
    return task.originalMarkdown || task.raw || task.lineText || null;
  }
  getTaskPath(task) {
    var _a, _b;
    return task.path || task.filePath || ((_b = (_a = task.file) == null ? void 0 : _a.path) != null ? _b : null);
  }
  getTaskLine(task) {
    var _a, _b, _c, _d, _e;
    const line = (_e = (_d = (_a = task.line) != null ? _a : task.lineNumber) != null ? _d : (_c = (_b = task.position) == null ? void 0 : _b.start) == null ? void 0 : _c.line) != null ? _e : null;
    return Number.isFinite(line) ? Number(line) : null;
  }
  normalizePriority(value) {
    var _a, _b, _c, _d;
    if (value === null || value === void 0) {
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
      const record = value;
      return (_d = (_c = (_b = (_a = this.normalizePriority(record.value)) != null ? _a : this.normalizePriority(record.priority)) != null ? _b : this.normalizePriority(record.id)) != null ? _c : this.normalizePriority(record.name)) != null ? _d : this.normalizePriority(record.label);
    }
    return null;
  }
  parsePriorityFromRaw(raw) {
    if (!raw) {
      return null;
    }
    if (raw.includes("\u23EB")) {
      return 4;
    }
    if (raw.includes("\u{1F53C}")) {
      return 3;
    }
    if (raw.includes("\u{1F53D}")) {
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
  getTaskPriority(task) {
    var _a, _b, _c;
    const fromField = (_c = (_b = (_a = this.normalizePriority(task.priority)) != null ? _a : this.normalizePriority(task.priorityNumber)) != null ? _b : this.normalizePriority(task.priorityValue)) != null ? _c : this.normalizePriority(task.urgency);
    if (fromField !== null) {
      return fromField;
    }
    const fromRaw = this.parsePriorityFromRaw(this.getTaskRaw(task));
    return fromRaw != null ? fromRaw : 0;
  }
  parseDateString(value) {
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
  normalizeDueTimestamp(value) {
    if (value === null || value === void 0) {
      return null;
    }
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e12 ? value : value * 1e3;
    }
    if (typeof value === "string") {
      return this.parseDateString(value);
    }
    if (typeof value === "object") {
      const record = value;
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
      if (typeof record.year === "number" && typeof record.month === "number" && typeof record.day === "number") {
        return Date.UTC(record.year, record.month - 1, record.day);
      }
      if (typeof record.date === "string") {
        return this.parseDateString(record.date);
      }
    }
    return null;
  }
  parseDueFromRaw(raw) {
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
  getTaskDueTimestamp(task) {
    var _a;
    const candidates = [
      task.dueDate,
      task.due,
      task.dueOn,
      task.dueDateTime,
      task.dueAt,
      task.dueDateString,
      (_a = task.dates) == null ? void 0 : _a.due
    ];
    for (const candidate of candidates) {
      const normalized = this.normalizeDueTimestamp(candidate);
      if (normalized !== null) {
        return normalized;
      }
    }
    return this.parseDueFromRaw(this.getTaskRaw(task));
  }
  toTaskRecord(task) {
    const text = this.getTaskText(task);
    const path = this.getTaskPath(task);
    const line = this.getTaskLine(task);
    const raw = this.getTaskRaw(task);
    const priority = this.getTaskPriority(task);
    const dueTimestamp = this.getTaskDueTimestamp(task);
    const storedId = this.getStoredTaskId(raw != null ? raw : text);
    const id = storedId != null ? storedId : this.hashTaskId(`${path != null ? path : ""}::${line != null ? line : ""}::${raw != null ? raw : text}`);
    const shortId = id.slice(0, 8);
    return { id, shortId, text, path, line, raw, priority, dueTimestamp };
  }
  async persistTaskIdTags(records) {
    var _a;
    const recordsByPath = /* @__PURE__ */ new Map();
    for (const record of records) {
      if (!record.path) {
        continue;
      }
      const existing = (_a = recordsByPath.get(record.path)) != null ? _a : [];
      existing.push(record);
      recordsByPath.set(record.path, existing);
    }
    const taskRegex = /^\s*-\s*\[ \]\s*/;
    for (const [path, fileRecords] of recordsByPath) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof import_obsidian.TFile)) {
        continue;
      }
      const contents = await this.app.vault.read(file);
      const lines = contents.split("\n");
      let changed = false;
      const matchesTaskLine = (lineText, record) => {
        if (!taskRegex.test(lineText)) {
          return false;
        }
        if (record.raw && lineText.includes(record.raw)) {
          return true;
        }
        if (record.text && lineText.includes(record.text)) {
          return true;
        }
        return false;
      };
      for (const record of fileRecords) {
        if (!record.id) {
          continue;
        }
        const candidateIndexes = [];
        if (typeof record.line === "number") {
          candidateIndexes.push(record.line, record.line - 1);
        }
        let updated = false;
        for (const index of candidateIndexes) {
          if (index < 0 || index >= lines.length) {
            continue;
          }
          if (!matchesTaskLine(lines[index], record)) {
            continue;
          }
          if (this.buildTaskIdTagRegex("i").test(lines[index])) {
            updated = true;
            break;
          }
          lines[index] = this.ensureTaskIdTag(lines[index], record.id);
          changed = true;
          updated = true;
          break;
        }
        if (updated) {
          continue;
        }
        for (let i = 0; i < lines.length; i += 1) {
          if (!matchesTaskLine(lines[i], record)) {
            continue;
          }
          if (this.buildTaskIdTagRegex("i").test(lines[i])) {
            break;
          }
          lines[i] = this.ensureTaskIdTag(lines[i], record.id);
          changed = true;
          break;
        }
      }
      if (changed) {
        await this.app.vault.modify(file, lines.join("\n"));
      }
    }
  }
  sortTasks(records) {
    const indexed = records.map((task, index) => ({ task, index }));
    indexed.sort((a, b) => {
      var _a, _b;
      if (a.task.priority !== b.task.priority) {
        return b.task.priority - a.task.priority;
      }
      const aDue = (_a = a.task.dueTimestamp) != null ? _a : Number.POSITIVE_INFINITY;
      const bDue = (_b = b.task.dueTimestamp) != null ? _b : Number.POSITIVE_INFINITY;
      if (aDue !== bDue) {
        return aDue - bDue;
      }
      return a.index - b.index;
    });
    return indexed.map(({ task }) => task);
  }
  hashTaskId(input) {
    let hash = 5381;
    for (let i = 0; i < input.length; i += 1) {
      hash = hash * 33 ^ input.charCodeAt(i);
    }
    return (hash >>> 0).toString(16).padStart(8, "0") + input.length.toString(16);
  }
  async collectTasks() {
    const api = this.getTasksApi();
    if (!api) {
      const tasks2 = await this.collectTasksFromVault();
      return this.sortTasks(tasks2);
    }
    const tasks = await this.queryTasksFromApi(api);
    if (tasks === null) {
      const tasks2 = await this.collectTasksFromVault();
      return this.sortTasks(tasks2);
    }
    const records = tasks.filter((task) => !this.isTaskCompleted(task)).map((task) => {
      const record = this.toTaskRecord(task);
      return { task, record };
    }).filter(({ task, record }) => this.taskMatchesGlobalTag(task, record)).map(({ record }) => record);
    await this.persistTaskIdTags(records);
    return this.sortTasks(records);
  }
  async collectTasksFromVault() {
    var _a, _b;
    const records = [];
    const files = this.app.vault.getMarkdownFiles();
    const taskRegex = /^\s*-\s*\[ \]\s*(.*)$/;
    const tagRegex = this.buildTagMatchRegex(this.settings.globalFilterTag);
    for (const file of files) {
      const contents = await this.app.vault.read(file);
      const lines = contents.split("\n");
      let changed = false;
      for (let i = 0; i < lines.length; i += 1) {
        const lineText = lines[i];
        const match = lineText.match(taskRegex);
        if (!match) {
          continue;
        }
        if (tagRegex && !tagRegex.test(lineText)) {
          continue;
        }
        const text = ((_a = match[1]) == null ? void 0 : _a.trim()) || "(unnamed task)";
        const storedId = this.getStoredTaskId(lineText);
        const id = storedId != null ? storedId : this.hashTaskId(`${file.path}::${i}::${lineText}`);
        const shortId = id.slice(0, 8);
        const priority = (_b = this.parsePriorityFromRaw(lineText)) != null ? _b : 0;
        const dueTimestamp = this.parseDueFromRaw(lineText);
        if (!storedId) {
          lines[i] = this.ensureTaskIdTag(lineText, id);
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
  async sendTasksNotification() {
    const tasks = await this.collectTasks();
    await this.sendTasksNotificationWithTasks(tasks);
  }
  async sendTasksNotificationWithRetry() {
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
  async sendTasksNotificationWithTasks(tasks) {
    if (!this.settings.botToken.trim() || !this.settings.chatId.trim()) {
      new import_obsidian.Notice("Telegram bot token or chat ID is missing.");
      return;
    }
    this.taskCache.clear();
    tasks.forEach((task) => this.taskCache.set(task.id, task));
    if (tasks.length === 0) {
      new import_obsidian.Notice("No unfinished tasks found.");
      return;
    }
    const maxTasks = Math.max(1, this.settings.maxTasksPerNotification);
    const shownTasks = tasks.slice(0, maxTasks);
    const header = `Unfinished tasks: ${tasks.length}`;
    const lines = shownTasks.map((task) => {
      const location = this.settings.includeFilePath && task.path ? ` (${task.path}${task.line !== null ? ":" + task.line : ""})` : "";
      return `- ${this.formatTaskTextForMessage(task.text)}${location} #${task.shortId}`;
    });
    const footer = tasks.length > shownTasks.length ? `...and ${tasks.length - shownTasks.length} more` : "";
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
  sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
  async pollTelegramUpdates() {
    var _a, _b, _c, _d, _e, _f;
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
      if ((_b = (_a = update.callback_query) == null ? void 0 : _a.data) == null ? void 0 : _b.startsWith("done:")) {
        const taskId = update.callback_query.data.slice("done:".length);
        const success = await this.completeTaskById(taskId);
        await this.telegramClient.answerCallbackQuery(
          update.callback_query.id,
          success ? "Task marked complete" : "Task not found"
        );
        continue;
      }
      const messageText = (_d = (_c = update.message) == null ? void 0 : _c.text) != null ? _d : "";
      const chatId = (_f = (_e = update.message) == null ? void 0 : _e.chat) == null ? void 0 : _f.id;
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
  async detectTelegramChatId() {
    var _a, _b, _c, _d, _e, _f, _g;
    if (!this.settings.botToken.trim()) {
      new import_obsidian.Notice("Telegram bot token is missing.");
      return;
    }
    const updates = await this.telegramClient.getUpdates(0);
    if (updates.length === 0) {
      new import_obsidian.Notice("No Telegram updates found. Send /start to the bot first.");
      return;
    }
    let latestUpdateId = this.settings.lastUpdateId;
    let detectedChatId = null;
    for (const update of updates) {
      latestUpdateId = Math.max(latestUpdateId, update.update_id);
      const chatId = (_g = (_f = (_b = (_a = update.message) == null ? void 0 : _a.chat) == null ? void 0 : _b.id) != null ? _f : (_e = (_d = (_c = update.callback_query) == null ? void 0 : _c.message) == null ? void 0 : _d.chat) == null ? void 0 : _e.id) != null ? _g : null;
      if (chatId !== null) {
        detectedChatId = chatId;
      }
    }
    if (detectedChatId === null) {
      new import_obsidian.Notice("No chat ID found in updates.");
      return;
    }
    this.settings.chatId = String(detectedChatId);
    this.settings.lastUpdateId = latestUpdateId;
    await this.saveSettings();
    new import_obsidian.Notice(`Telegram chat ID set to ${detectedChatId}`);
  }
  async completeTaskById(taskId) {
    const cached = this.taskCache.get(taskId);
    const task = cached != null ? cached : await this.findTaskById(taskId);
    if (!task) {
      new import_obsidian.Notice(`Task not found for ID ${taskId}`);
      return false;
    }
    const updated = await this.markTaskComplete(task);
    if (updated) {
      new import_obsidian.Notice(`Task marked complete: ${task.text}`);
    }
    return updated;
  }
  async findTaskById(taskId) {
    const tasks = await this.collectTasks();
    for (const task of tasks) {
      if (task.id === taskId || task.shortId === taskId) {
        return task;
      }
    }
    return null;
  }
  async markTaskComplete(task) {
    if (!task.path) {
      return false;
    }
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof import_obsidian.TFile)) {
      return false;
    }
    const contents = await this.app.vault.read(file);
    const lines = contents.split("\n");
    const candidateIndexes = [];
    if (typeof task.line === "number") {
      candidateIndexes.push(task.line, task.line - 1);
    }
    const matchesTaskLine = (lineText) => {
      if (task.raw && lineText.includes(task.raw)) {
        return true;
      }
      if (task.text && lineText.includes(task.text)) {
        return true;
      }
      return false;
    };
    const replaceCheckbox = (lineText) => {
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
};
var TelegramTasksNotifierSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Telegram Tasks Notifier" });
    new import_obsidian.Setting(containerEl).setName("Tasks query").setDesc("Tasks plugin query used to fetch unfinished tasks.").addText(
      (text) => text.setPlaceholder("not done").setValue(this.plugin.settings.tasksQuery).onChange(async (value) => {
        this.plugin.settings.tasksQuery = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Global filter tag").setDesc("Only include tasks that have this tag (e.g. #work).").addText(
      (text) => text.setPlaceholder("#work").setValue(this.plugin.settings.globalFilterTag).onChange(async (value) => {
        this.plugin.settings.globalFilterTag = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Telegram bot token").setDesc("Bot token from BotFather.").addText(
      (text) => text.setPlaceholder("123456:ABC-DEF...").setValue(this.plugin.settings.botToken).onChange(async (value) => {
        this.plugin.settings.botToken = value.trim();
        await this.plugin.saveSettings();
        await this.plugin.maybeDetectTelegramChatId();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Telegram chat ID").setDesc("Chat ID where notifications are sent.").addText(
      (text) => text.setPlaceholder("123456789").setValue(this.plugin.settings.chatId).onChange(async (value) => {
        this.plugin.settings.chatId = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Notify on startup").setDesc("Send tasks notification when Obsidian starts.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.notifyOnStartup).onChange(async (value) => {
        this.plugin.settings.notifyOnStartup = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Notification interval (minutes)").setDesc("Set to 0 to disable periodic notifications.").addText(
      (text) => text.setPlaceholder("60").setValue(String(this.plugin.settings.notificationIntervalMinutes)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        this.plugin.settings.notificationIntervalMinutes = Number.isFinite(parsed) ? parsed : 0;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Poll Telegram updates").setDesc("Enable polling for reactions to mark tasks complete.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enableTelegramPolling).onChange(async (value) => {
        this.plugin.settings.enableTelegramPolling = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Polling interval (seconds)").setDesc("How often to poll Telegram for updates.").addText(
      (text) => text.setPlaceholder("10").setValue(String(this.plugin.settings.pollIntervalSeconds)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        this.plugin.settings.pollIntervalSeconds = Number.isFinite(parsed) ? parsed : 10;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Max tasks per notification").setDesc("Limits the number of tasks shown in one Telegram message.").addText(
      (text) => text.setPlaceholder("20").setValue(String(this.plugin.settings.maxTasksPerNotification)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        this.plugin.settings.maxTasksPerNotification = Number.isFinite(parsed) ? parsed : 20;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Include file path").setDesc("Include file path and line number in each task line.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.includeFilePath).onChange(async (value) => {
        this.plugin.settings.includeFilePath = value;
        await this.plugin.saveSettings();
      })
    );
  }
};
