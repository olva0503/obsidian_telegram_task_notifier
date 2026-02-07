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
var import_obsidian2 = require("obsidian");

// task-id.ts
var TASK_ID_TAG_PREFIX = "#taskid/";
var buildTaskIdTagRegex = (flags = "i") => {
  const escapedPrefix = TASK_ID_TAG_PREFIX.replace("/", "\\/");
  return new RegExp(`(^|\\s)${escapedPrefix}[0-9a-f]+(?=\\s|$|[.,;:!?])`, flags);
};
var buildTaskIdTagRegexForId = (id, flags = "i") => {
  const escapedPrefix = TASK_ID_TAG_PREFIX.replace("/", "\\/");
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escapedPrefix}${escapedId}(?=\\s|$|[.,;:!?])`, flags);
};
var getStoredTaskId = (text) => {
  if (!text) {
    return null;
  }
  const escapedPrefix = TASK_ID_TAG_PREFIX.replace("/", "\\/");
  const match = text.match(
    new RegExp(`(?:^|\\s)${escapedPrefix}([0-9a-f]+)(?=\\s|$|[.,;:!?])`, "i")
  );
  return match ? match[1].toLowerCase() : null;
};
var stripTaskIdTag = (text) => {
  const cleaned = text.replace(buildTaskIdTagRegex("gi"), " ").replace(/\s{2,}/g, " ").trim();
  return cleaned || text;
};
var ensureTaskIdTag = (lineText, id) => {
  if (buildTaskIdTagRegex("i").test(lineText)) {
    return lineText;
  }
  const suffix = lineText.endsWith(" ") ? "" : " ";
  return `${lineText}${suffix}${TASK_ID_TAG_PREFIX}${id.toLowerCase()}`;
};
var hashTaskId = (input) => {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = hash * 33 ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0") + input.length.toString(16);
};

// tasks.ts
var isTaskLike = (value) => {
  return !!value && typeof value === "object";
};
var normalizeTasksQuery = (input) => {
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
};
var normalizeTagFilter = (value) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
};
var buildTagMatchRegex = (tag) => {
  const normalized = normalizeTagFilter(tag);
  if (!normalized) {
    return null;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$|[.,;:!?])`, "i");
};
var formatTaskTextForMessage = (text, matcher) => {
  const cleanedTaskId = stripTaskIdTag(text);
  if (!matcher) {
    return cleanedTaskId;
  }
  const cleaned = cleanedTaskId.replace(matcher, " ").replace(/\s{2,}/g, " ").trim();
  return cleaned || cleanedTaskId;
};
var taskMatchesGlobalTag = (task, record, globalTag, matcher) => {
  var _a, _b, _c, _d;
  const tag = normalizeTagFilter(globalTag);
  if (!tag) {
    return true;
  }
  const lowerTag = tag.toLowerCase();
  if (Array.isArray(task.tags)) {
    const matchesArray = task.tags.some((entry) => {
      if (typeof entry !== "string") {
        return false;
      }
      const normalized = normalizeTagFilter(entry).toLowerCase();
      return normalized === lowerTag;
    });
    if (matchesArray) {
      return true;
    }
  }
  const raw = (_b = (_a = record.raw) != null ? _a : getTaskRaw(task)) != null ? _b : "";
  const text = (_d = (_c = record.text) != null ? _c : getTaskText(task)) != null ? _d : "";
  const resolvedMatcher = matcher === void 0 ? buildTagMatchRegex(tag) : matcher;
  if (!resolvedMatcher) {
    return true;
  }
  return resolvedMatcher.test(raw) || resolvedMatcher.test(text);
};
var isUncheckedTaskLine = (lineText) => {
  return /^\s*-\s*\[ \]\s*/.test(lineText);
};
var isTaskLine = (lineText) => {
  return /^\s*-\s*\[[ xX]\]\s*/.test(lineText);
};
var getUncheckedTaskText = (lineText) => {
  const match = lineText.match(/^\s*-\s*\[ \]\s*(.*)$/);
  return match ? match[1] : null;
};
var matchesTaskLine = (lineText, record, requireUnchecked) => {
  if (requireUnchecked) {
    if (!isUncheckedTaskLine(lineText)) {
      return false;
    }
  } else if (!isTaskLine(lineText)) {
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
var replaceCheckbox = (lineText) => {
  if (!/\[[^\]]\]/.test(lineText)) {
    return null;
  }
  const updated = lineText.replace(/\[[^\]]\]/, "[x]");
  return updated === lineText ? null : updated;
};
var isTaskCompleted = (task) => {
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
  const raw = getTaskRaw(task);
  if (raw && /\[[xX]\]/.test(raw)) {
    return true;
  }
  return false;
};
var getTaskText = (task) => {
  return task.description || task.text || task.task || task.content || getTaskRaw(task) || "(unnamed task)";
};
var getTaskRaw = (task) => {
  return task.originalMarkdown || task.raw || task.lineText || null;
};
var getTaskPath = (task) => {
  var _a;
  return task.path || task.filePath || ((_a = task.file) == null ? void 0 : _a.path) || null;
};
var getTaskLine = (task) => {
  var _a, _b, _c, _d, _e;
  const line = (_e = (_d = (_a = task.line) != null ? _a : task.lineNumber) != null ? _d : (_c = (_b = task.position) == null ? void 0 : _b.start) == null ? void 0 : _c.line) != null ? _e : null;
  return Number.isFinite(line) ? Number(line) : null;
};
var normalizeExternalId = (value) => {
  var _a;
  if (value === null || value === void 0) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "object") {
    const record = value;
    return normalizeExternalId((_a = record.id) != null ? _a : record.value);
  }
  return null;
};
var getTaskExternalId = (task) => {
  const candidates = [task.id, task.uuid, task.uid, task.taskId, task.blockId, task.$id];
  for (const candidate of candidates) {
    const normalized = normalizeExternalId(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
};
var normalizePriority = (value) => {
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
    return (_d = (_c = (_b = (_a = normalizePriority(record.value)) != null ? _a : normalizePriority(record.priority)) != null ? _b : normalizePriority(record.id)) != null ? _c : normalizePriority(record.name)) != null ? _d : normalizePriority(record.label);
  }
  return null;
};
var parsePriorityFromRaw = (raw) => {
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
    return normalizePriority(keywordMatch[1]);
  }
  return null;
};
var getTaskPriority = (task) => {
  var _a, _b, _c;
  const fromField = (_c = (_b = (_a = normalizePriority(task.priority)) != null ? _a : normalizePriority(task.priorityNumber)) != null ? _b : normalizePriority(task.priorityValue)) != null ? _c : normalizePriority(task.urgency);
  if (fromField !== null) {
    return fromField;
  }
  const fromRaw = parsePriorityFromRaw(getTaskRaw(task));
  return fromRaw != null ? fromRaw : 0;
};
var parseDateString = (value) => {
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
};
var normalizeDueTimestamp = (value) => {
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
    return parseDateString(value);
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
      return parseDateString(record.toISO());
    }
    if (typeof record.year === "number" && typeof record.month === "number" && typeof record.day === "number") {
      return Date.UTC(record.year, record.month - 1, record.day);
    }
    if (typeof record.date === "string") {
      return parseDateString(record.date);
    }
  }
  return null;
};
var parseDueFromRaw = (raw) => {
  if (!raw) {
    return null;
  }
  const emojiMatch = raw.match(/\uD83D\uDCC5\s*(\d{4}-\d{2}-\d{2})/);
  if (emojiMatch) {
    return parseDateString(emojiMatch[1]);
  }
  const dueMatch = raw.match(/\bdue[:\s]*([0-9]{4}-[0-9]{2}-[0-9]{2})\b/i);
  if (dueMatch) {
    return parseDateString(dueMatch[1]);
  }
  return null;
};
var getTaskDueTimestamp = (task) => {
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
    const normalized = normalizeDueTimestamp(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }
  return parseDueFromRaw(getTaskRaw(task));
};
var toTaskRecord = (task) => {
  const text = getTaskText(task);
  const path = getTaskPath(task);
  const line = getTaskLine(task);
  const raw = getTaskRaw(task);
  const priority = getTaskPriority(task);
  const dueTimestamp = getTaskDueTimestamp(task);
  const storedId = getStoredTaskId(raw != null ? raw : text);
  const externalId = getTaskExternalId(task);
  const identityPieces = [path != null ? path : "", line != null ? line : "", raw != null ? raw : text];
  if (externalId) {
    identityPieces.push(`external:${externalId}`);
  }
  const id = storedId != null ? storedId : hashTaskId(identityPieces.join("::"));
  const shortId = id.slice(0, 8);
  return { id, shortId, text, path, line, raw, priority, dueTimestamp };
};
var ensureTaskIdTagOnLine = (lineText, id) => {
  return ensureTaskIdTag(lineText, id);
};
var hasTaskIdTag = (lineText) => {
  return buildTaskIdTagRegex("i").test(lineText);
};

// settings.ts
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
  lastUpdateId: 0,
  allowedTelegramUserIds: [],
  taskIdTaggingMode: "always"
};
var parseAllowedUserIds = (value) => {
  if (!value.trim()) {
    return [];
  }
  const parts = value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  const ids = parts.map((entry) => Number.parseInt(entry, 10)).filter((entry) => Number.isFinite(entry));
  return Array.from(new Set(ids));
};
var formatAllowedUserIds = (ids) => {
  return ids.length > 0 ? ids.join(", ") : "";
};

// telegram.ts
var import_obsidian = require("obsidian");
var TelegramClient = class {
  constructor(getSettings) {
    this.getSettings = getSettings;
  }
  get apiBase() {
    const token = this.getSettings().botToken.trim();
    return `https://api.telegram.org/bot${token}`;
  }
  async sendMessage(text, replyMarkup) {
    await this.requestResult("/sendMessage", {
      chat_id: this.getSettings().chatId.trim(),
      text,
      reply_markup: replyMarkup
    });
  }
  async getUpdates(offset, timeoutSeconds) {
    const response = await this.requestResult(
      "/getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"]
      },
      {
        retries: 0
      }
    );
    return response != null ? response : [];
  }
  async answerCallbackQuery(id, text) {
    await this.requestResult("/answerCallbackQuery", {
      callback_query_id: id,
      text
    });
  }
  async requestResult(path, body, options) {
    const data = await this.requestJson(path, body, options);
    if (!data.ok) {
      throw new Error(data.description || "Telegram API request failed");
    }
    return data.result;
  }
  async requestJson(path, body, options) {
    var _a;
    const retries = (_a = options == null ? void 0 : options.retries) != null ? _a : 2;
    let attempt = 0;
    let lastError;
    while (attempt <= retries) {
      try {
        const response = await (0, import_obsidian.requestUrl)({
          url: `${this.apiBase}${path}`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        return response.json;
      } catch (error) {
        lastError = error;
        if (attempt >= retries) {
          break;
        }
        const backoffMs = 750 * Math.pow(2, attempt);
        await new Promise((resolve) => window.setTimeout(resolve, backoffMs));
      }
      attempt += 1;
    }
    throw lastError instanceof Error ? lastError : new Error("Telegram request failed");
  }
};

// main.ts
var TELEGRAM_SAFE_MESSAGE_LENGTH = 3900;
var TELEGRAM_MAX_LINE_LENGTH = 3500;
var TelegramTasksNotifierPlugin = class extends import_obsidian2.Plugin {
  constructor() {
    super(...arguments);
    this.notificationIntervalId = null;
    this.pollingLoopPromise = null;
    this.pollingAbort = false;
    this.pollingInFlight = false;
    this.sendInFlight = false;
    this.pollingErrorStreak = 0;
    this.taskCache = /* @__PURE__ */ new Map();
  }
  async onload() {
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
      this.startPollingLoop();
    }
  }
  clearIntervals() {
    if (this.notificationIntervalId !== null) {
      window.clearInterval(this.notificationIntervalId);
      this.notificationIntervalId = null;
    }
    this.stopPollingLoop();
  }
  startPollingLoop() {
    if (this.pollingLoopPromise) {
      return;
    }
    this.pollingAbort = false;
    this.pollingLoopPromise = this.pollTelegramUpdatesLoop().finally(() => {
      this.pollingLoopPromise = null;
    });
  }
  stopPollingLoop() {
    this.pollingAbort = true;
  }
  async pollTelegramUpdatesLoop() {
    while (!this.pollingAbort && this.settings.enableTelegramPolling) {
      try {
        await this.pollTelegramUpdates();
        this.pollingErrorStreak = 0;
      } catch (error) {
        this.pollingErrorStreak += 1;
        const backoff = this.getPollingBackoffMs(this.pollingErrorStreak);
        console.warn("Telegram polling failed", error);
        new import_obsidian2.Notice("Telegram polling failed. Retrying soon.");
        await this.sleep(backoff);
      }
    }
  }
  getPollingBackoffMs(errorStreak) {
    const baseMs = 1e3;
    const maxMs = 3e4;
    const backoff = baseMs * Math.pow(2, Math.min(4, errorStreak));
    const jitter = Math.floor(Math.random() * 500);
    return Math.min(maxMs, backoff + jitter);
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async saveSettingsAndReconfigure() {
    await this.saveSettings();
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
  normalizeQueryResult(result) {
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
  }
  async queryTasksFromApi(api) {
    var _a, _b;
    const query = normalizeTasksQuery(this.settings.tasksQuery);
    const queryFn = (_b = (_a = api.getTasks) != null ? _a : api.getTasksFromQuery) != null ? _b : api.queryTasks;
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
  shouldPersistTaskIdTags(mode = this.settings.taskIdTaggingMode) {
    return mode === "always";
  }
  async collectTasks() {
    const api = this.getTasksApi();
    if (!api) {
      const tasks2 = await this.collectTasksFromVault();
      return this.sortTasks(tasks2);
    }
    const tasks = await this.queryTasksFromApi(api);
    if (tasks === null) {
      const fallback = await this.collectTasksFromVault();
      return this.sortTasks(fallback);
    }
    const tagMatcher = buildTagMatchRegex(this.settings.globalFilterTag);
    const records = tasks.filter((task) => !isTaskCompleted(task)).map((task) => {
      const record = toTaskRecord(task);
      return { task, record };
    }).filter(({ task, record }) => taskMatchesGlobalTag(task, record, this.settings.globalFilterTag, tagMatcher)).map(({ record }) => record);
    if (this.shouldPersistTaskIdTags()) {
      await this.persistTaskIdTags(records);
    }
    return this.sortTasks(records);
  }
  async collectTasksFromVault() {
    var _a;
    const records = [];
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
        const id = storedId != null ? storedId : hashTaskId(`${file.path}::${i}::${lineText}`);
        const shortId = id.slice(0, 8);
        const priority = (_a = parsePriorityFromRaw(lineText)) != null ? _a : 0;
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
  async persistTaskIdTags(records) {
    var _a;
    if (!this.shouldPersistTaskIdTags()) {
      return;
    }
    const recordsByPath = /* @__PURE__ */ new Map();
    for (const record of records) {
      if (!record.path) {
        continue;
      }
      const existing = (_a = recordsByPath.get(record.path)) != null ? _a : [];
      existing.push(record);
      recordsByPath.set(record.path, existing);
    }
    for (const [path, fileRecords] of recordsByPath) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof import_obsidian2.TFile)) {
        continue;
      }
      const contents = await this.app.vault.read(file);
      const lines = contents.split("\n");
      let changed = false;
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
  async sendTasksNotification() {
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
      new import_obsidian2.Notice("Telegram bot token or chat ID is missing.");
      return;
    }
    this.taskCache.clear();
    tasks.forEach((task) => this.taskCache.set(task.id, task));
    if (tasks.length === 0) {
      new import_obsidian2.Notice("No unfinished tasks found.");
      return;
    }
    const maxTasks = Math.max(1, this.settings.maxTasksPerNotification);
    const shownTasks = tasks.slice(0, maxTasks);
    const tagMatcher = buildTagMatchRegex(this.settings.globalFilterTag);
    const header = `Unfinished tasks: ${tasks.length}`;
    const lines = shownTasks.map((task) => {
      const location = this.settings.includeFilePath && task.path ? ` (${task.path}${task.line !== null ? ":" + (task.line + 1) : ""})` : "";
      return `- ${formatTaskTextForMessage(task.text, tagMatcher)}${location} #${task.shortId}`;
    });
    const footer = tasks.length > shownTasks.length ? `...and ${tasks.length - shownTasks.length} more` : "";
    const messages = this.buildTelegramMessages(header, lines, footer);
    if (messages.length === 0) {
      return;
    }
    const replyMarkup = {
      inline_keyboard: shownTasks.map((task) => [
        {
          text: `Done #${task.shortId}`,
          callback_data: `done:${task.id}`
        }
      ])
    };
    for (let i = 0; i < messages.length; i += 1) {
      const text = messages[i];
      const markup = i === 0 ? replyMarkup : void 0;
      const sent = await this.safeTelegramCall("send message", () => this.telegramClient.sendMessage(text, markup));
      if (!sent) {
        return;
      }
    }
  }
  buildTelegramMessages(header, lines, footer) {
    const messages = [];
    const continuedHeader = "Unfinished tasks (continued):";
    let buffer = [header, ""];
    let currentLength = buffer.join("\n").length;
    const pushBuffer = () => {
      const text = buffer.join("\n").trimEnd();
      if (text) {
        messages.push(text);
      }
    };
    const addLine = (line) => {
      const trimmedLine = line.length > TELEGRAM_MAX_LINE_LENGTH ? `${line.slice(0, TELEGRAM_MAX_LINE_LENGTH - 3)}...` : line;
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
  async safeTelegramCall(label, action) {
    try {
      return await action();
    } catch (error) {
      console.warn(`Telegram ${label} failed`, error);
      new import_obsidian2.Notice(`Telegram ${label} failed. Check your connection or bot settings.`);
      return null;
    }
  }
  sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
  isAllowedChatId(chatId) {
    const configured = this.settings.chatId.trim();
    if (!configured || chatId === void 0 || chatId === null) {
      return false;
    }
    return String(chatId) === configured;
  }
  isAllowedTelegramUser(userId) {
    if (userId === void 0 || userId === null) {
      return false;
    }
    const allowed = this.settings.allowedTelegramUserIds;
    if (!allowed || allowed.length === 0) {
      return true;
    }
    return allowed.includes(userId);
  }
  isAuthorizedUpdate(chatId, userId) {
    return this.isAllowedChatId(chatId) && this.isAllowedTelegramUser(userId);
  }
  async pollTelegramUpdates() {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
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
        if ((_a = callback == null ? void 0 : callback.data) == null ? void 0 : _a.startsWith("done:")) {
          const taskId = callback.data.slice("done:".length);
          const callbackChatId = (_c = (_b = callback.message) == null ? void 0 : _b.chat) == null ? void 0 : _c.id;
          const callbackUserId = (_d = callback.from) == null ? void 0 : _d.id;
          if (!this.isAuthorizedUpdate(callbackChatId, callbackUserId)) {
            await this.safeTelegramCall(
              "answer callback query",
              () => this.telegramClient.answerCallbackQuery(callback.id, "Unauthorized")
            );
            continue;
          }
          const success = await this.completeTaskById(taskId);
          await this.safeTelegramCall(
            "answer callback query",
            () => this.telegramClient.answerCallbackQuery(
              callback.id,
              success ? "Task marked complete" : "Task not found"
            )
          );
          continue;
        }
        const messageText = (_f = (_e = update.message) == null ? void 0 : _e.text) != null ? _f : "";
        const chatId = (_h = (_g = update.message) == null ? void 0 : _g.chat) == null ? void 0 : _h.id;
        const userId = (_j = (_i = update.message) == null ? void 0 : _i.from) == null ? void 0 : _j.id;
        if (!this.isAuthorizedUpdate(chatId, userId)) {
          continue;
        }
        const match = messageText.match(/^\s*done\s+([a-f0-9]+)\s*$/i);
        if (match) {
          await this.completeTaskById(match[1]);
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
  async detectTelegramChatId() {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (!this.settings.botToken.trim()) {
      new import_obsidian2.Notice("Telegram bot token is missing.");
      return;
    }
    const updates = await this.telegramClient.getUpdates(0, 0);
    if (updates.length === 0) {
      new import_obsidian2.Notice("No Telegram updates found. Send /start to the bot first.");
      return;
    }
    const ordered = [...updates].sort((a, b) => a.update_id - b.update_id);
    let latestUpdateId = this.settings.lastUpdateId;
    let detectedChatId = null;
    let startChatId = null;
    for (const update of ordered) {
      latestUpdateId = Math.max(latestUpdateId, update.update_id);
      const messageChatId = (_c = (_b = (_a = update.message) == null ? void 0 : _a.chat) == null ? void 0 : _b.id) != null ? _c : null;
      const callbackChatId = (_g = (_f = (_e = (_d = update.callback_query) == null ? void 0 : _d.message) == null ? void 0 : _e.chat) == null ? void 0 : _f.id) != null ? _g : null;
      if (((_h = update.message) == null ? void 0 : _h.text) && /^\s*\/start\b/i.test(update.message.text)) {
        startChatId = messageChatId;
      }
      if (messageChatId !== null) {
        detectedChatId = messageChatId;
      } else if (callbackChatId !== null) {
        detectedChatId = callbackChatId;
      }
    }
    const resolvedChatId = startChatId != null ? startChatId : detectedChatId;
    if (resolvedChatId === null) {
      new import_obsidian2.Notice("No chat ID found in updates.");
      return;
    }
    if (!startChatId) {
      new import_obsidian2.Notice("No /start message found. Using latest chat ID from updates.");
    }
    this.settings.chatId = String(resolvedChatId);
    this.settings.lastUpdateId = latestUpdateId;
    await this.saveSettings();
    new import_obsidian2.Notice(`Telegram chat ID set to ${resolvedChatId}`);
  }
  async completeTaskById(taskId) {
    const cached = this.taskCache.get(taskId);
    const task = cached != null ? cached : await this.findTaskById(taskId);
    if (!task) {
      new import_obsidian2.Notice(`Task not found for ID ${taskId}`);
      return false;
    }
    const updated = await this.markTaskComplete(task);
    if (updated) {
      new import_obsidian2.Notice(`Task marked complete: ${task.text}`);
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
    if (!(file instanceof import_obsidian2.TFile)) {
      return false;
    }
    const contents = await this.app.vault.read(file);
    const lines = contents.split("\n");
    const shouldTag = this.settings.taskIdTaggingMode !== "never";
    const idTagRegex = buildTaskIdTagRegexForId(task.id, "i");
    const candidateIndexes = [];
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
        const nextLine = shouldTag && !hasTaskIdTag(updated) ? ensureTaskIdTagOnLine(updated, task.id) : updated;
        lines[index] = nextLine;
        await this.app.vault.modify(file, lines.join("\n"));
        return true;
      }
    }
    for (let i = 0; i < lines.length; i += 1) {
      if (idTagRegex.test(lines[i]) && isTaskLine(lines[i])) {
        const updated2 = replaceCheckbox(lines[i]);
        if (updated2) {
          const nextLine = shouldTag && !hasTaskIdTag(updated2) ? ensureTaskIdTagOnLine(updated2, task.id) : updated2;
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
        const nextLine = shouldTag && !hasTaskIdTag(updated) ? ensureTaskIdTagOnLine(updated, task.id) : updated;
        lines[i] = nextLine;
        await this.app.vault.modify(file, lines.join("\n"));
        return true;
      }
    }
    return false;
  }
};
var TelegramTasksNotifierSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Telegram Tasks Notifier" });
    new import_obsidian2.Setting(containerEl).setName("Tasks query").setDesc("Tasks plugin query used to fetch unfinished tasks.").addText(
      (text) => text.setPlaceholder("not done").setValue(this.plugin.settings.tasksQuery).onChange(async (value) => {
        this.plugin.settings.tasksQuery = value;
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Global filter tag").setDesc("Only include tasks that have this tag (e.g. #work).").addText(
      (text) => text.setPlaceholder("#work").setValue(this.plugin.settings.globalFilterTag).onChange(async (value) => {
        this.plugin.settings.globalFilterTag = value.trim();
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Telegram bot token").setDesc("Bot token from BotFather.").addText(
      (text) => text.setPlaceholder("123456:ABC-DEF...").setValue(this.plugin.settings.botToken).onChange(async (value) => {
        this.plugin.settings.botToken = value.trim();
        await this.plugin.saveSettingsAndReconfigure();
        await this.plugin.maybeDetectTelegramChatId();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Telegram chat ID").setDesc("Chat ID where notifications are sent.").addText(
      (text) => text.setPlaceholder("123456789").setValue(this.plugin.settings.chatId).onChange(async (value) => {
        this.plugin.settings.chatId = value.trim();
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Allowed Telegram user IDs").setDesc("Optional comma-separated user IDs allowed to mark tasks complete.").addText(
      (text) => text.setPlaceholder("123456, 789012").setValue(formatAllowedUserIds(this.plugin.settings.allowedTelegramUserIds)).onChange(async (value) => {
        this.plugin.settings.allowedTelegramUserIds = parseAllowedUserIds(value);
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Task ID tagging mode").setDesc("Controls when #taskid tags are written to task lines.").addDropdown(
      (dropdown) => dropdown.addOption("always", "Always").addOption("on-complete", "Only on completion").addOption("never", "Never").setValue(this.plugin.settings.taskIdTaggingMode).onChange(async (value) => {
        this.plugin.settings.taskIdTaggingMode = value;
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Notify on startup").setDesc("Send tasks notification when Obsidian starts.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.notifyOnStartup).onChange(async (value) => {
        this.plugin.settings.notifyOnStartup = value;
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Notification interval (minutes)").setDesc("Set to 0 to disable periodic notifications.").addText(
      (text) => text.setPlaceholder("60").setValue(String(this.plugin.settings.notificationIntervalMinutes)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        this.plugin.settings.notificationIntervalMinutes = Number.isFinite(parsed) ? parsed : 0;
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Poll Telegram updates").setDesc("Enable polling for reactions to mark tasks complete.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enableTelegramPolling).onChange(async (value) => {
        this.plugin.settings.enableTelegramPolling = value;
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Polling interval (seconds)").setDesc("How long Telegram long-polls for updates.").addText(
      (text) => text.setPlaceholder("10").setValue(String(this.plugin.settings.pollIntervalSeconds)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        this.plugin.settings.pollIntervalSeconds = Number.isFinite(parsed) ? parsed : 10;
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Max tasks per notification").setDesc("Limits the number of tasks shown in one Telegram message.").addText(
      (text) => text.setPlaceholder("20").setValue(String(this.plugin.settings.maxTasksPerNotification)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        this.plugin.settings.maxTasksPerNotification = Number.isFinite(parsed) ? parsed : 20;
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Include file path").setDesc("Include file path and line number in each task line.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.includeFilePath).onChange(async (value) => {
        this.plugin.settings.includeFilePath = value;
        await this.plugin.saveSettingsAndReconfigure();
      })
    );
  }
};
