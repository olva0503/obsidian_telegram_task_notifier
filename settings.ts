export type TaskIdTaggingMode = "always" | "on-complete" | "never";

export interface TelegramTasksNotifierSettings {
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
  allowedTelegramUserIds: number[];
  taskIdTaggingMode: TaskIdTaggingMode;
}

export const DEFAULT_SETTINGS: TelegramTasksNotifierSettings = {
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

export const parseAllowedUserIds = (value: string): number[] => {
  if (!value.trim()) {
    return [];
  }
  const parts = value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  const ids = parts
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isFinite(entry));
  return Array.from(new Set(ids));
};

export const formatAllowedUserIds = (ids: number[]): string => {
  return ids.length > 0 ? ids.join(", ") : "";
};
