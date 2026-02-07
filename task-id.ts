export const TASK_ID_TAG_PREFIX = "#taskid/";

export const buildTaskIdTagRegex = (flags: "i" | "gi" = "i"): RegExp => {
  const escapedPrefix = TASK_ID_TAG_PREFIX.replace("/", "\\/");
  return new RegExp(`(^|\\s)${escapedPrefix}[0-9a-f]+(?=\\s|$|[.,;:!?])`, flags);
};

export const getStoredTaskId = (text: string | null): string | null => {
  if (!text) {
    return null;
  }
  const match = text.match(buildTaskIdTagRegex("i"));
  if (!match) {
    return null;
  }
  const idMatch = match[0].match(/[0-9a-f]+/i);
  return idMatch ? idMatch[0].toLowerCase() : null;
};

export const stripTaskIdTag = (text: string): string => {
  const cleaned = text.replace(buildTaskIdTagRegex("gi"), " ").replace(/\s{2,}/g, " ").trim();
  return cleaned || text;
};

export const ensureTaskIdTag = (lineText: string, id: string): string => {
  if (buildTaskIdTagRegex("i").test(lineText)) {
    return lineText;
  }
  const suffix = lineText.endsWith(" ") ? "" : " ";
  return `${lineText}${suffix}${TASK_ID_TAG_PREFIX}${id.toLowerCase()}`;
};

export const hashTaskId = (input: string): string => {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0") + input.length.toString(16);
};
