import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SETTINGS,
  formatAllowedUserIds,
  formatChatIds,
  parseAllowedUserIds,
  parseChatIds
} from "../settings";

describe("settings", () => {
  it("parses allowed user IDs from strings", () => {
    expect(parseAllowedUserIds("")) .toEqual([]);
    expect(parseAllowedUserIds("123, 456 123")) .toEqual([123, 456]);
  });

  it("formats allowed user IDs", () => {
    expect(formatAllowedUserIds([])).toBe("");
    expect(formatAllowedUserIds([1, 2, 3])) .toBe("1, 2, 3");
  });

  it("parses chat IDs from strings", () => {
    expect(parseChatIds("")) .toEqual([]);
    expect(parseChatIds("123, 456 123")) .toEqual([123, 456]);
  });

  it("formats chat IDs", () => {
    expect(formatChatIds([])) .toBe("");
    expect(formatChatIds([1, 2, 3])) .toBe("1, 2, 3");
  });

  it("has default settings values", () => {
    expect(DEFAULT_SETTINGS.tasksQuery).toBe("not done");
    expect(DEFAULT_SETTINGS.taskIdTaggingMode).toBe("always");
    expect(DEFAULT_SETTINGS.dailyNotePathTemplate).toBe("");
    expect(DEFAULT_SETTINGS.hostChatId).toBe("");
  });
});
