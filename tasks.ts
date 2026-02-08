import {
  buildTaskIdTagRegex,
  ensureTaskIdTag,
  getStoredTaskId,
  hashTaskId,
  stripTaskIdTag
} from "./task-id";

export type TaskRecord = {
  id: string;
  shortId: string;
  text: string;
  path: string | null;
  line: number | null;
  raw: string | null;
  priority: number;
  dueTimestamp: number | null;
};

export type TaskLike = {
  description?: string;
  text?: string;
  task?: string;
  content?: string;
  originalMarkdown?: string;
  raw?: string;
  lineText?: string;
  path?: string;
  filePath?: string;
  file?: { path?: string };
  line?: number;
  lineNumber?: number;
  position?: { start?: { line?: number } };
  id?: unknown;
  uuid?: unknown;
  uid?: unknown;
  taskId?: unknown;
  blockId?: unknown;
  $id?: unknown;
  priority?: unknown;
  priorityNumber?: unknown;
  priorityValue?: unknown;
  urgency?: unknown;
  dueDate?: unknown;
  due?: unknown;
  dueOn?: unknown;
  dueDateTime?: unknown;
  dueAt?: unknown;
  dueDateString?: unknown;
  dates?: { due?: unknown };
  completed?: boolean;
  isCompleted?: boolean;
  status?: { type?: string; isCompleted?: boolean };
  tags?: unknown;
};

export const isTaskLike = (value: unknown): value is TaskLike => {
  return !!value && typeof value === "object";
};

export const normalizeTasksQuery = (input: string): string => {
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

export const normalizeTagFilter = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
};

export const buildTagMatchRegex = (tag: string): RegExp | null => {
  const normalized = normalizeTagFilter(tag);
  if (!normalized) {
    return null;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$|[.,;:!?])`, "i");
};

export const formatTaskTextForMessage = (text: string, matcher?: RegExp | null): string => {
  const cleanedTaskId = stripTaskIdTag(text);
  if (!matcher) {
    return cleanedTaskId;
  }
  const cleaned = cleanedTaskId.replace(matcher, " ").replace(/\s{2,}/g, " ").trim();
  return cleaned || cleanedTaskId;
};

export const taskMatchesGlobalTag = (
  task: TaskLike,
  record: TaskRecord,
  globalTag: string,
  matcher?: RegExp | null
): boolean => {
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
  const raw = record.raw ?? getTaskRaw(task) ?? "";
  const text = record.text ?? getTaskText(task) ?? "";
  const resolvedMatcher = matcher === undefined ? buildTagMatchRegex(tag) : matcher;
  if (!resolvedMatcher) {
    return true;
  }
  return resolvedMatcher.test(raw) || resolvedMatcher.test(text);
};

export const isUncheckedTaskLine = (lineText: string): boolean => {
  return /^\s*-\s*\[ \]\s*/.test(lineText);
};

export const isTaskLine = (lineText: string): boolean => {
  return /^\s*-\s*\[[ xX]\]\s*/.test(lineText);
};

export const getUncheckedTaskText = (lineText: string): string | null => {
  const match = lineText.match(/^\s*-\s*\[ \]\s*(.*)$/);
  return match ? match[1] : null;
};

export const matchesTaskLine = (lineText: string, record: TaskRecord, requireUnchecked: boolean): boolean => {
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

export const replaceCheckbox = (lineText: string): string | null => {
  if (!/\[[^\]]\]/.test(lineText)) {
    return null;
  }
  const updated = lineText.replace(/\[[^\]]\]/, "[x]");
  return updated === lineText ? null : updated;
};

export const isTaskCompleted = (task: TaskLike): boolean => {
  if (task.completed === true || task.isCompleted === true) {
    return true;
  }
  const status = task.status;
  if (status?.isCompleted === true) {
    return true;
  }
  if (typeof status?.type === "string" && status.type.toLowerCase() === "done") {
    return true;
  }
  const raw = getTaskRaw(task);
  if (raw && /\[[xX]\]/.test(raw)) {
    return true;
  }
  return false;
};

export const getTaskText = (task: TaskLike): string => {
  return (
    task.description ||
    task.text ||
    task.task ||
    task.content ||
    getTaskRaw(task) ||
    "(unnamed task)"
  );
};

export const getTaskRaw = (task: TaskLike): string | null => {
  return task.originalMarkdown || task.raw || task.lineText || null;
};

export const getTaskPath = (task: TaskLike): string | null => {
  return task.path || task.filePath || task.file?.path || null;
};

export const getTaskLine = (task: TaskLike): number | null => {
  const line =
    task.line ??
    task.lineNumber ??
    task.position?.start?.line ??
    null;
  return Number.isFinite(line) ? Number(line) : null;
};

const normalizeExternalId = (value: unknown): string | null => {
  if (value === null || value === undefined) {
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
    const record = value as { id?: unknown; value?: unknown };
    return normalizeExternalId(record.id ?? record.value);
  }
  return null;
};

const getTaskExternalId = (task: TaskLike): string | null => {
  const candidates = [task.id, task.uuid, task.uid, task.taskId, task.blockId, task.$id];
  for (const candidate of candidates) {
    const normalized = normalizeExternalId(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
};

const normalizePriority = (value: unknown): number | null => {
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
      normalizePriority(record.value) ??
      normalizePriority(record.priority) ??
      normalizePriority(record.id) ??
      normalizePriority(record.name) ??
      normalizePriority(record.label)
    );
  }
  return null;
};

export const parsePriorityFromRaw = (raw: string | null): number | null => {
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
    return normalizePriority(keywordMatch[1]);
  }
  return null;
};

export const getTaskPriority = (task: TaskLike): number => {
  const fromField =
    normalizePriority(task.priority) ??
    normalizePriority(task.priorityNumber) ??
    normalizePriority(task.priorityValue) ??
    normalizePriority(task.urgency);
  if (fromField !== null) {
    return fromField;
  }
  const fromRaw = parsePriorityFromRaw(getTaskRaw(task));
  return fromRaw ?? 0;
};

const parseDateString = (value: string): number | null => {
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

const normalizeDueTimestamp = (value: unknown): number | null => {
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
    return parseDateString(value);
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
      return parseDateString(record.toISO());
    }
    if (
      typeof record.year === "number" &&
      typeof record.month === "number" &&
      typeof record.day === "number"
    ) {
      return Date.UTC(record.year, record.month - 1, record.day);
    }
    if (typeof record.date === "string") {
      return parseDateString(record.date);
    }
  }
  return null;
};

export const parseDueFromRaw = (raw: string | null): number | null => {
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

const extractDueDateStringFromInput = (input: string): string | null => {
  const dueMatch = input.match(/(?:\b(?:due|date)\s*[:=]?\s*|\uD83D\uDCC5\s*)(\d{4}-\d{2}-\d{2})/i);
  if (!dueMatch) {
    return null;
  }
  return parseDateString(dueMatch[1]) !== null ? dueMatch[1] : null;
};

const extractPriorityFromInput = (input: string): number | null => {
  const fromRaw = parsePriorityFromRaw(input);
  if (fromRaw !== null) {
    return fromRaw;
  }
  const pMatch = input.match(/\bp([0-4])\b/i);
  if (pMatch) {
    return Number.parseInt(pMatch[1], 10);
  }
  const numericMatch = input.match(/\bpriority\s*[:=]?\s*([0-4])\b/i);
  if (numericMatch) {
    return Number.parseInt(numericMatch[1], 10);
  }
  return null;
};

const priorityToEmoji = (priority: number | null): string | null => {
  if (priority === null) {
    return null;
  }
  if (priority >= 4) {
    return "\u23EB";
  }
  if (priority === 3) {
    return "\uD83D\uDD3C";
  }
  if (priority === 1) {
    return "\uD83D\uDD3D";
  }
  if (priority <= 0) {
    return "\u23EC";
  }
  return null;
};

export const buildTaskLineFromInput = (input: string): {
  lineText: string;
  cleanedText: string;
  dueDate: string | null;
  priority: number | null;
} => {
  let cleaned = input.trim();
  cleaned = cleaned.replace(/^\s*-\s*\[[ xX]\]\s*/, "");

  const dueDate = extractDueDateStringFromInput(cleaned);
  const priority = extractPriorityFromInput(cleaned);

  const duePattern = /(?:\b(?:due|date)\s*[:=]?\s*|\uD83D\uDCC5\s*)(\d{4}-\d{2}-\d{2})/gi;
  const priorityPattern =
    /\bpriority\s*[:=]?\s*(highest|urgent|top|high|medium|normal|default|low|lowest|none|p[0-4]|[0-4])\b/gi;

  cleaned = cleaned
    .replace(duePattern, " ")
    .replace(priorityPattern, " ")
    .replace(/\bp[0-4]\b/gi, " ")
    .replace(/[\u23EB\u23EC\uD83D\uDD3C\uD83D\uDD3D]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!cleaned) {
    cleaned = "(unnamed task)";
  }

  let lineText = `- [ ] ${cleaned}`;
  const priorityEmoji = priorityToEmoji(priority);
  if (priorityEmoji) {
    lineText += ` ${priorityEmoji}`;
  }
  if (dueDate) {
    lineText += ` \uD83D\uDCC5 ${dueDate}`;
  }

  return { lineText, cleanedText: cleaned, dueDate, priority };
};

export const getTaskDueTimestamp = (task: TaskLike): number | null => {
  const candidates = [
    task.dueDate,
    task.due,
    task.dueOn,
    task.dueDateTime,
    task.dueAt,
    task.dueDateString,
    task.dates?.due
  ];
  for (const candidate of candidates) {
    const normalized = normalizeDueTimestamp(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }
  return parseDueFromRaw(getTaskRaw(task));
};

export const toTaskRecord = (task: TaskLike): TaskRecord => {
  const text = getTaskText(task);
  const path = getTaskPath(task);
  const line = getTaskLine(task);
  const raw = getTaskRaw(task);
  const priority = getTaskPriority(task);
  const dueTimestamp = getTaskDueTimestamp(task);
  const storedId = getStoredTaskId(raw ?? text);
  const externalId = getTaskExternalId(task);
  const identityPieces = [path ?? "", line ?? "", raw ?? text];
  if (externalId) {
    identityPieces.push(`external:${externalId}`);
  }
  const id = storedId ?? hashTaskId(identityPieces.join("::"));
  const shortId = id.slice(0, 8);
  return { id, shortId, text, path, line, raw, priority, dueTimestamp };
};

export const ensureTaskIdTagOnLine = (lineText: string, id: string): string => {
  return ensureTaskIdTag(lineText, id);
};

export const hasTaskIdTag = (lineText: string): boolean => {
  return buildTaskIdTagRegex("i").test(lineText);
};
