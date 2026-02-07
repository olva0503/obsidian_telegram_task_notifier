class Notice {
  static messages: string[] = [];
  message: string;

  constructor(message: string) {
    this.message = message;
    Notice.messages.push(message);
  }
}

class TFile {
  path: string;

  constructor(path: string = "") {
    this.path = path;
  }
}

class Plugin {
  app: unknown;
  private storedData: unknown = null;

  constructor(app: unknown) {
    this.app = app;
  }

  addSettingTab(): void {}
  addCommand(): void {}

  async loadData(): Promise<unknown> {
    return this.storedData;
  }

  async saveData(data: unknown): Promise<void> {
    this.storedData = data;
  }
}

class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl = {
    empty: () => {},
    createEl: () => ({})
  };

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
}

class Setting {
  setName(): this {
    return this;
  }

  setDesc(): this {
    return this;
  }

  addText(): this {
    return this;
  }

  addDropdown(): this {
    return this;
  }

  addToggle(): this {
    return this;
  }
}

type RequestUrlMock = ((options: unknown) => Promise<unknown>) & {
  mockCalls: unknown[];
  mockReset: () => void;
  mockResolvedValue: (value: unknown) => void;
};

const createRequestUrlMock = (): RequestUrlMock => {
  let resolvedValue: unknown = undefined;
  const fn = (async (options: unknown) => {
    fn.mockCalls.push(options);
    return resolvedValue;
  }) as RequestUrlMock;

  fn.mockCalls = [];
  fn.mockReset = () => {
    fn.mockCalls = [];
    resolvedValue = undefined;
  };
  fn.mockResolvedValue = (value: unknown) => {
    resolvedValue = value;
  };

  return fn;
};

const requestUrl = createRequestUrlMock();

class App {}

export { App, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl };
