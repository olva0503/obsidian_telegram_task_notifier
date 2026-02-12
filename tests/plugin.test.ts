import { beforeEach, describe, expect, it } from "bun:test";
import { TFile } from "obsidian";
import { setDailyNoteSettings, setGetAllDailyNotes } from "obsidian-daily-notes-interface";
import TelegramTasksNotifierPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import { hashTaskId, TASK_ID_TAG_PREFIX } from "../task-id";

type VaultFile = {
  file: TFile;
  contents: string;
  isFolder?: boolean;
};

const createApp = (files: Record<string, string>) => {
  const store = new Map<string, VaultFile>();
  Object.entries(files).forEach(([path, contents]) => {
    const file = Object.assign(new TFile(), { path });
    store.set(path, { file, contents });
  });

  const vault = {
    getMarkdownFiles: () =>
      Array.from(store.values())
        .filter((entry) => !entry.isFolder)
        .map((entry) => entry.file),
    read: async (file: TFile) => store.get(file.path)?.contents ?? "",
    modify: async (file: TFile, contents: string) => {
      const entry = store.get(file.path);
      if (entry && !entry.isFolder) {
        entry.contents = contents;
      }
    },
    create: async (path: string, contents: string) => {
      const file = Object.assign(new TFile(), { path });
      store.set(path, { file, contents });
      return file;
    },
    createFolder: async (path: string) => {
      const file = Object.assign(new TFile(), { path });
      store.set(path, { file, contents: "", isFolder: true });
    },
    getAbstractFileByPath: (path: string) => {
      const entry = store.get(path);
      if (!entry) {
        return undefined;
      }
      return entry.isFolder ? { path } : entry.file;
    }
  };

  return {
    vault,
    workspace: { onLayoutReady: (callback: () => void) => callback() },
    __store: store
  };
};

describe("TelegramTasksNotifierPlugin", () => {
  beforeEach(() => {
    setDailyNoteSettings({
      folder: "",
      format: "YYYY-MM-DD"
    });
    setGetAllDailyNotes(null);
  });

  it("responds to /list by sending unfinished tasks", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      taskIdTaggingMode: "never",
      lastUpdateId: 5
    };

    const sent: Array<{ text: string; markup?: unknown }> = [];
    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 5,
          message: {
            text: "/list",
            chat: { id: 123 },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async (_chatId: string | number, text: string, reply_markup?: unknown) => {
        sent.push({ text, markup: reply_markup });
      },
      answerCallbackQuery: async () => {}
    };

    await (plugin as any).pollTelegramUpdates();

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("Unfinished tasks: 1");
    expect(sent[0].text).toContain("Task one");
    const keyboard = (sent[0].markup as { inline_keyboard?: Array<Array<{ text?: string }>> })?.inline_keyboard;
    expect(keyboard?.length).toBe(2);
    expect(keyboard?.[1]?.[0]?.text).toBe("List");
  });

  it("responds to /help with shared tasks guidance for host", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      taskIdTaggingMode: "never",
      lastUpdateId: 0
    };

    const sent: string[] = [];
    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 1,
          message: {
            text: "/help",
            chat: { id: 123 },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async (_chatId: string | number, text: string) => {
        sent.push(text);
      },
      answerCallbackQuery: async () => {}
    };

    await (plugin as any).pollTelegramUpdates();

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("/list");
    expect(sent[0]).toContain("done <id>");
    expect(sent[0]).toContain("due:");
    expect(sent[0]).toContain("priority");
    expect(sent[0]).toContain("#recur/");
    expect(sent[0]).toContain("Shared tasks (admin)");
    expect(sent[0]).toContain("#shared");
  });

  it("responds to /help without shared tasks guidance for guest", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one #shared"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      guestChatIds: [456],
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      taskIdTaggingMode: "never",
      lastUpdateId: 0
    };

    const sent: string[] = [];
    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 1,
          message: {
            text: "/help",
            chat: { id: 456 },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async (_chatId: string | number, text: string) => {
        sent.push(text);
      },
      answerCallbackQuery: async () => {}
    };

    await (plugin as any).pollTelegramUpdates();

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("/list");
    expect(sent[0]).toContain("done <id>");
    expect(sent[0]).toContain("due:");
    expect(sent[0]).toContain("priority");
    expect(sent[0]).toContain("#recur/");
    expect(sent[0]).not.toContain("Shared tasks (admin)");
  });

  it("sends updated list after completing a task via callback", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one\n- [ ] Task two"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      taskIdTaggingMode: "never",
      lastUpdateId: 0
    };

    const lineText = "- [ ] Task one";
    const taskId = hashTaskId(`Notes.md::0::${lineText}`);
    const sent: string[] = [];
    const callbacks: string[] = [];
    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 1,
          callback_query: {
            id: "cb-1",
            data: `done:${taskId}`,
            message: { chat: { id: 123 } },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async (_chatId: string | number, text: string) => {
        sent.push(text);
      },
      answerCallbackQuery: async (_id: string, text?: string) => {
        if (text) {
          callbacks.push(text);
        }
      }
    };

    await (plugin as any).pollTelegramUpdates();

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("Unfinished tasks: 1");
    expect(sent[0]).toContain("Task two");
    expect(sent[0]).not.toContain("Task one");
    expect(callbacks[0]).toBe("Task marked complete");
  });

  it("sends done message when callback task is missing", async () => {
    const app = createApp({});
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      taskIdTaggingMode: "never",
      lastUpdateId: 0
    };

    const sent: string[] = [];
    const callbacks: string[] = [];
    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 1,
          callback_query: {
            id: "cb-2",
            data: "done:deadbeef",
            message: { chat: { id: 123 } },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async (_chatId: string | number, text: string) => {
        sent.push(text);
      },
      answerCallbackQuery: async (_id: string, text?: string) => {
        if (text) {
          callbacks.push(text);
        }
      }
    };

    await (plugin as any).pollTelegramUpdates();

    expect(sent[0]).toBe("All tasks are done.");
    expect(callbacks[0]).toBe("All tasks are done.");
  });

  it("allows adding tasks from same chat id", async () => {
    const app = createApp({ "Notes.md": "" });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      allowedTelegramUserIds: [111],
      lastUpdateId: 0
    };

    const added: string[] = [];
    (plugin as any).addTaskFromTelegram = async (text: string) => {
      added.push(text);
    };

    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 1,
          message: {
            text: "Buy milk",
            chat: { id: 123 },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async () => {},
      answerCallbackQuery: async () => {}
    };

    await (plugin as any).pollTelegramUpdates();

    expect(added).toEqual(["Buy milk"]);
  });

  it("adds telegram tasks to the daily note and confirms", async () => {
    const app = createApp({ "2024-01-01.md": "" });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      globalFilterTag: "#work",
      taskIdTaggingMode: "always"
    };

    const sent: string[] = [];
    (plugin as any).telegramClient = {
      sendMessageTo: async (_chatId: string | number, text: string) => {
        sent.push(text);
      }
    };

    await (plugin as any).addTaskFromTelegram("Buy milk", { role: "host", chatId: 123 });

    const lineText = "- [ ] #work Buy milk";
    const id = hashTaskId(`2024-01-01.md::0::${lineText}`);
    const shortId = id.slice(0, 8);
    const stored = app.__store.get("2024-01-01.md");
    expect(stored?.contents).toBe(`${lineText} ${TASK_ID_TAG_PREFIX}${id}`);
    expect(sent[0]).toBe(`Added task: Buy milk #${shortId}`);
  });

  it("falls back to creating a note when daily notes index fails", async () => {
    setGetAllDailyNotes(() => {
      throw new Error("boom");
    });
    const app = createApp({ "2024-01-01.md": "" });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      taskIdTaggingMode: "never"
    };

    (plugin as any).telegramClient = {
      sendMessageTo: async () => {}
    };

    await (plugin as any).addTaskFromTelegram("Buy milk", { role: "host", chatId: 123 });

    const stored = app.__store.get("2024-01-01.md");
    expect(stored?.contents).toContain("- [ ] Buy milk");
  });

  it("creates a fallback note when daily notes are not configured", async () => {
    setDailyNoteSettings(null);
    const app = createApp({});
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123"
    };

    const sent: string[] = [];
    (plugin as any).telegramClient = {
      sendMessageTo: async (_chatId: string | number, text: string) => {
        sent.push(text);
      }
    };

    await (plugin as any).addTaskFromTelegram("Buy milk", { role: "host", chatId: 123 });

    const createdEntries = Array.from(app.__store.entries()).filter(([, entry]) => !entry.isFolder);
    expect(createdEntries.length).toBe(1);
    const created = createdEntries[0];
    expect(created?.[1]?.contents).toContain("- [ ] Buy milk");
    expect(sent[0]?.startsWith("Added task: Buy milk #")).toBe(true);
  });

  it("uses the daily note path override when configured", async () => {
    const app = createApp({});
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      dailyNotePathTemplate: "Inbox.md"
    };

    (plugin as any).telegramClient = {
      sendMessageTo: async () => {}
    };

    await (plugin as any).addTaskFromTelegram("Buy milk", { role: "host", chatId: 123 });

    const stored = app.__store.get("Inbox.md");
    expect(stored?.contents).toContain("- [ ] Buy milk");
  });

  it("collects tasks from vault and persists task IDs", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one #work\n- [ ] Task two #home"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      globalFilterTag: "#work",
      taskIdTaggingMode: "always"
    };

    const tasks = await (plugin as any).collectTasksFromVault();
    expect(tasks.length).toBe(1);
    const stored = app.__store.get("Notes.md");
    expect(stored?.contents).toContain("#taskid/");
  });

  it("marks tasks complete and tags when configured", async () => {
    const line = "- [ ] Ship release";
    const id = hashTaskId(`Notes.md::0::${line}`);
    const app = createApp({ "Notes.md": line });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      taskIdTaggingMode: "on-complete"
    };

    const record = {
      id,
      shortId: id.slice(0, 8),
      text: "Ship release",
      path: "Notes.md",
      line: 0,
      raw: line,
      priority: 0,
      dueTimestamp: null
    };

    const result = await (plugin as any).markTaskComplete(record);
    expect(result).toBe(true);
    const stored = app.__store.get("Notes.md");
    expect(stored?.contents).toContain("- [x] Ship release");
    expect(stored?.contents).toContain("#taskid/");
  });

  it("stores recurring completion timestamp when marking task complete", async () => {
    const line = "- [ ] Pay rent #recur/1mo";
    const id = hashTaskId(`Notes.md::0::${line}`);
    const app = createApp({ "Notes.md": line });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      taskIdTaggingMode: "never"
    };

    const now = 1710000000000;
    const originalNow = Date.now;
    Date.now = () => now;

    try {
      const record = {
        id,
        shortId: id.slice(0, 8),
        text: "Pay rent #recur/1mo",
        path: "Notes.md",
        line: 0,
        raw: line,
        priority: 0,
        dueTimestamp: null
      };

      const result = await (plugin as any).markTaskComplete(record);
      expect(result).toBe(true);
      const stored = app.__store.get("Notes.md");
      expect(stored?.contents).toContain("- [x] Pay rent #recur/1mo");
      expect(stored?.contents).toContain(`#recurdone/${now}`);
    } finally {
      Date.now = originalNow;
    }
  });

  it("reopens completed recurring tasks after interval", async () => {
    const now = 1710000000000;
    const completedAt = now - 2 * 60 * 60 * 1000;
    const app = createApp({
      "Notes.md": `- [x] Water plants #recur/1h #recurdone/${completedAt}`
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      taskIdTaggingMode: "never"
    };

    await (plugin as any).reopenRecurringTasksInVault(now);

    const stored = app.__store.get("Notes.md");
    expect(stored?.contents).toContain("- [ ] Water plants #recur/1h");
    expect(stored?.contents).not.toContain("#recurdone/");
  });

  it("keeps completed recurring tasks done before interval", async () => {
    const now = 1710000000000;
    const completedAt = now - 30 * 60 * 1000;
    const app = createApp({
      "Notes.md": `- [x] Water plants #recur/1h #recurdone/${completedAt}`
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      taskIdTaggingMode: "never"
    };

    await (plugin as any).reopenRecurringTasksInVault(now);

    const stored = app.__store.get("Notes.md");
    expect(stored?.contents).toContain("- [x] Water plants #recur/1h");
    expect(stored?.contents).toContain(`#recurdone/${completedAt}`);
  });

  it("records requestor chat IDs from /start", async () => {
    const app = createApp({ "Notes.md": "- [ ] Task one" });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      lastUpdateId: 0
    };

    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 1,
          message: {
            text: "/start",
            chat: { id: 777 },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async () => {},
      answerCallbackQuery: async () => {}
    };

    await (plugin as any).pollTelegramUpdates();

    expect(plugin.settings.requestors).toEqual([777]);
  });

  it("filters guest task list to shared tasks", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one #shared\n- [ ] Task two"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      guestChatIds: [456],
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      taskIdTaggingMode: "never",
      lastUpdateId: 0
    };

    const sent: string[] = [];
    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 1,
          message: {
            text: "/list",
            chat: { id: 456 },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async (_chatId: string | number, text: string) => {
        sent.push(text);
      },
      answerCallbackQuery: async () => {}
    };

    await (plugin as any).pollTelegramUpdates();

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("Unfinished tasks: 1");
    expect(sent[0]).toContain("Task one");
    expect(sent[0]).not.toContain("#shared");
    expect(sent[0]).not.toContain("Task two");
  });

  it("adds #shared tag for guest-added tasks", async () => {
    const app = createApp({ "2024-01-01.md": "" });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      taskIdTaggingMode: "never"
    };

    (plugin as any).telegramClient = {
      sendMessageTo: async () => {}
    };

    await (plugin as any).addTaskFromTelegram("Buy milk", { role: "guest", chatId: 456 });

    const stored = app.__store.get("2024-01-01.md");
    expect(stored?.contents).toContain("- [ ] #shared Buy milk");
  });

  it("redistributes task list to all chats when a guest adds a shared task", async () => {
    const app = createApp({ "2024-01-01.md": "" });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      guestChatIds: [456],
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      taskIdTaggingMode: "never",
      lastUpdateId: 0
    };

    const sent: Array<{ chatId: number | string; text: string }> = [];
    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 1,
          message: {
            text: "Buy milk",
            chat: { id: 456 },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
      },
      answerCallbackQuery: async () => {}
    };

    await (plugin as any).pollTelegramUpdates();

    const hostMessages = sent.filter((entry) => Number(entry.chatId) === 123).map((entry) => entry.text);
    const guestMessages = sent.filter((entry) => Number(entry.chatId) === 456).map((entry) => entry.text);

    expect(hostMessages.some((text) => text.includes("Unfinished tasks: 1") && text.includes("Buy milk"))).toBe(true);
    expect(guestMessages.some((text) => text.startsWith("Added task: Buy milk #"))).toBe(true);
    expect(guestMessages.some((text) => text.includes("Unfinished tasks: 1") && text.includes("Buy milk"))).toBe(true);
  });

  it("does not redistribute to all chats when host adds a non-shared task", async () => {
    const app = createApp({ "2024-01-01.md": "" });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      guestChatIds: [456],
      enableTelegramPolling: true,
      pollIntervalSeconds: 10,
      taskIdTaggingMode: "never",
      lastUpdateId: 0
    };

    const sent: Array<{ chatId: number | string; text: string }> = [];
    (plugin as any).telegramClient = {
      getUpdates: async () => [
        {
          update_id: 1,
          message: {
            text: "Buy milk",
            chat: { id: 123 },
            from: { id: 999 }
          }
        }
      ],
      sendMessageTo: async (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
      },
      answerCallbackQuery: async () => {}
    };

    await (plugin as any).pollTelegramUpdates();

    expect(sent.length).toBe(1);
    expect(Number(sent[0]?.chatId)).toBe(123);
    expect(sent[0]?.text.startsWith("Added task: Buy milk #")).toBe(true);
  });

  it("skips interval notification when interval has not elapsed", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      notificationIntervalMinutes: 60,
      taskIdTaggingMode: "never",
      lastIntervalNotificationSentAt: Date.now()
    };

    const sent: string[] = [];
    (plugin as any).telegramClient = {
      sendMessageTo: async (_chatId: string | number, text: string) => {
        sent.push(text);
      }
    };

    await (plugin as any).sendIntervalNotificationIfDue();

    expect(sent).toEqual([]);
  });

  it("sends interval notification once elapsed and stores timestamp", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    const before = Date.now() - 61 * 60 * 1000;
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      notificationIntervalMinutes: 60,
      taskIdTaggingMode: "never",
      lastIntervalNotificationSentAt: before
    };

    const sent: string[] = [];
    (plugin as any).telegramClient = {
      sendMessageTo: async (_chatId: string | number, text: string) => {
        sent.push(text);
      }
    };

    await (plugin as any).sendIntervalNotificationIfDue();

    expect(sent.length).toBe(1);
    expect(plugin.settings.lastIntervalNotificationSentAt).toBeGreaterThan(before);
  });

  it("does not store interval timestamp when send fails", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    const before = Date.now() - 61 * 60 * 1000;
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      botToken: "token",
      hostChatId: "123",
      notificationIntervalMinutes: 60,
      taskIdTaggingMode: "never",
      lastIntervalNotificationSentAt: before
    };

    (plugin as any).telegramClient = {
      sendMessageTo: async () => {
        throw new Error("network down");
      }
    };

    await (plugin as any).sendIntervalNotificationIfDue();

    expect(plugin.settings.lastIntervalNotificationSentAt).toBe(before);
  });

  it("configures recurring sweep interval even when notifications are disabled", () => {
    const app = createApp({
      "Notes.md": "- [x] Water plants #recur/1h #recurdone/1710000000000"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      notificationIntervalMinutes: 0,
      enableTelegramPolling: false
    };

    const windowRef = ((globalThis as unknown as { window?: typeof globalThis }).window ?? globalThis) as typeof globalThis;
    const originalWindow = (globalThis as unknown as { window?: typeof globalThis }).window;
    (globalThis as unknown as { window: typeof globalThis }).window = windowRef;

    const originalSetInterval = windowRef.setInterval;
    const originalClearInterval = windowRef.clearInterval;
    const intervals: number[] = [];

    windowRef.setInterval = ((callback: TimerHandler, timeout?: number) => {
      void callback;
      intervals.push(Number(timeout ?? 0));
      return 1;
    }) as typeof windowRef.setInterval;
    windowRef.clearInterval = (() => {}) as typeof windowRef.clearInterval;

    try {
      (plugin as any).configureIntervals();
      expect(intervals).toContain(60 * 1000);
    } finally {
      windowRef.setInterval = originalSetInterval;
      windowRef.clearInterval = originalClearInterval;
      if (originalWindow === undefined) {
        delete (globalThis as unknown as { window?: typeof globalThis }).window;
      } else {
        (globalThis as unknown as { window: typeof globalThis }).window = originalWindow;
      }
    }
  });

  it("prevents guests from completing non-shared tasks", async () => {
    const app = createApp({
      "Notes.md": "- [ ] Task one\n- [ ] Task two #shared"
    });
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      taskIdTaggingMode: "never"
    };

    const tasks = await (plugin as any).collectTasksFromVault();
    const nonShared = tasks.find((task: { text?: string }) => task.text === "Task one");
    expect(nonShared).toBeTruthy();
    const success = await (plugin as any).completeTaskById(nonShared.id, "guest");
    expect(success).toBe(false);
    const stored = app.__store.get("Notes.md");
    expect(stored?.contents).toContain("- [ ] Task one");
  });

  it("normalizes Tasks API results", () => {
    const app = createApp({});
    const plugin = new (TelegramTasksNotifierPlugin as any)(app);
    const normalize = (plugin as any).normalizeQueryResult.bind(plugin);

    expect(normalize({ tasks: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(normalize({ items: [{ id: 2 }] })).toEqual([{ id: 2 }]);
    expect(normalize({ results: [{ id: 3 }] })).toEqual([{ id: 3 }]);
    expect(normalize({})).toEqual([]);
  });
});
