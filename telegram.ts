import { requestUrl } from "obsidian";
import type { TelegramTasksNotifierSettings } from "./settings";

export type TelegramUpdate = {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; username?: string; is_bot?: boolean };
    message?: { message_id: number; chat?: { id: number } };
  };
  message?: {
    text?: string;
    chat?: { id: number };
    from?: { id: number; username?: string; is_bot?: boolean };
  };
};

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

export class TelegramClient {
  constructor(private readonly getSettings: () => TelegramTasksNotifierSettings) {}

  private get apiBase(): string {
    const token = this.getSettings().botToken.trim();
    return `https://api.telegram.org/bot${token}`;
  }

  async sendMessage(text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
    await this.requestResult<void>("/sendMessage", {
      chat_id: this.getSettings().chatId.trim(),
      text,
      reply_markup: replyMarkup
    });
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const response = await this.requestResult<TelegramUpdate[]>(
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
    return response ?? [];
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.requestResult<void>("/answerCallbackQuery", {
      callback_query_id: id,
      text
    });
  }

  private async requestResult<T>(
    path: string,
    body: Record<string, unknown>,
    options?: { retries?: number }
  ): Promise<T> {
    const data = await this.requestJson<TelegramResponse<T>>(path, body, options);
    if (!data.ok) {
      throw new Error(data.description || "Telegram API request failed");
    }
    return data.result;
  }

  private async requestJson<T>(
    path: string,
    body: Record<string, unknown>,
    options?: { retries?: number }
  ): Promise<T> {
    const retries = options?.retries ?? 2;
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= retries) {
      try {
        const response = await requestUrl({
          url: `${this.apiBase}${path}`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        return response.json as T;
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
}
