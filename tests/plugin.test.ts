import { describe, expect, it } from "bun:test";
import { TFile } from "obsidian";
import TelegramTasksNotifierPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import { hashTaskId } from "../task-id";

type VaultFile = {
  file: TFile;
  contents: string;
};

const createApp = (files: Record<string, string>) => {
  const store = new Map<string, VaultFile>();
  Object.entries(files).forEach(([path, contents]) => {
    const file = Object.assign(new TFile(), { path });
    store.set(path, { file, contents });
  });

  const vault = {
    getMarkdownFiles: () => Array.from(store.values()).map((entry) => entry.file),
    read: async (file: TFile) => store.get(file.path)?.contents ?? "",
    modify: async (file: TFile, contents: string) => {
      const entry = store.get(file.path);
      if (entry) {
        entry.contents = contents;
      }
    },
    getAbstractFileByPath: (path: string) => store.get(path)?.file
  };

  return {
    vault,
    workspace: { onLayoutReady: (callback: () => void) => callback() },
    __store: store
  };
};

describe("TelegramTasksNotifierPlugin", () => {
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
