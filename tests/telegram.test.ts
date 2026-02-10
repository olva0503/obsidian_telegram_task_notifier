import { beforeEach, describe, expect, it } from "bun:test";
import { requestUrl } from "obsidian";
import { TelegramClient } from "../telegram";
import { DEFAULT_SETTINGS } from "../settings";

describe("TelegramClient", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    botToken: "token",
    hostChatId: "123"
  };

  beforeEach(() => {
    requestUrl.mockReset();
  });

  it("sends messages with chat id", async () => {
    requestUrl.mockResolvedValue({
      json: { ok: true, result: true }
    });
    const client = new TelegramClient(() => settings);
    await client.sendMessage("hello");
    const [call] = requestUrl.mockCalls;
    expect(call).toBeTruthy();
    expect((call as { url?: string }).url).toBe("https://api.telegram.org/bottoken/sendMessage");
    expect((call as { method?: string }).method).toBe("POST");
  });

  it("passes allowed_updates for getUpdates", async () => {
    requestUrl.mockResolvedValue({
      json: { ok: true, result: [] }
    });
    const client = new TelegramClient(() => settings);
    const updates = await client.getUpdates(5, 2);
    expect(updates).toEqual([]);
    const [call] = requestUrl.mockCalls;
    expect(call).toBeTruthy();
    expect((call as { url?: string }).url).toBe("https://api.telegram.org/bottoken/getUpdates");
  });

  it("throws on API error", async () => {
    requestUrl.mockResolvedValue({
      json: { ok: false, result: null, description: "bad" }
    });
    const client = new TelegramClient(() => settings);
    await expect(client.getUpdates(0, 1)).rejects.toThrow("bad");
  });
});
