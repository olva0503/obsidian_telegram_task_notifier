export type TaskIdTaggingMode = "always" | "on-complete" | "never";

export interface TelegramTasksNotifierSettings {
  botToken: string;
  hostChatId: string;
  guestChatIds: number[];
  requestors: number[];
  tasksQuery: string;
  globalFilterTag: string;
  dailyNotePathTemplate: string;
  notifyOnStartup: boolean;
  notificationIntervalMinutes: number;
  pollIntervalSeconds: number;
  maxTasksPerNotification: number;
  includeFilePath: boolean;
  enableTelegramPolling: boolean;
  lastUpdateId: number;
  allowedTelegramUserIds: number[];
  taskIdTaggingMode: TaskIdTaggingMode;
  lastIntervalNotificationSentAt: number;
  lastReminderCheckAt: number;
}

export const DEFAULT_SETTINGS: TelegramTasksNotifierSettings = {
  botToken: "",
  hostChatId: "",
  guestChatIds: [],
  requestors: [],
  tasksQuery: "not done",
  globalFilterTag: "",
  dailyNotePathTemplate: "",
  notifyOnStartup: true,
  notificationIntervalMinutes: 1,
  pollIntervalSeconds: 10,
  maxTasksPerNotification: 20,
  includeFilePath: true,
  enableTelegramPolling: true,
  lastUpdateId: 0,
  allowedTelegramUserIds: [],
  taskIdTaggingMode: "always",
  lastIntervalNotificationSentAt: 0,
  lastReminderCheckAt: 0
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

export const parseChatIds = (value: string): number[] => {
  if (!value.trim()) {
    return [];
  }
  const parts = value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  const ids = parts
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isFinite(entry));
  return Array.from(new Set(ids));
};

export const formatChatIds = (ids: number[]): string => {
  return ids.length > 0 ? ids.join(", ") : "";
};
