import { describe, expect, it } from "bun:test";
import {
  buildTagMatchRegex,
  buildTaskLineFromInput,
  formatTaskTextForMessage,
  getRecurrenceNextTimestamp,
  getRecurringCompletedAt,
  getTaskDueTimestamp,
  getTaskPriority,
  getTaskText,
  isCompletedTaskLine,
  isRecurringTaskDue,
  isTaskCompleted,
  isTaskLine,
  isUncheckedTaskLine,
  matchesTaskLine,
  normalizeTasksQuery,
  parseRecurrenceFromRaw,
  parseDueFromRaw,
  parsePriorityFromRaw,
  replaceCheckbox,
  stripRecurringCompletedTag,
  taskMatchesGlobalTag,
  toTaskRecord,
  uncheckCheckbox,
  upsertRecurringCompletedTag
} from "../tasks";

describe("tasks utilities", () => {
  it("normalizes tasks query from fenced block", () => {
    const input = "```tasks\nnot done\npath includes Inbox\n```";
    expect(normalizeTasksQuery(input)).toBe("not done\npath includes Inbox");
  });

  it("normalizes tasks query from prefix", () => {
    expect(normalizeTasksQuery("tasks not done")).toBe("not done");
  });

  it("builds and applies tag matcher", () => {
    const matcher = buildTagMatchRegex("work");
    expect(matcher?.test("do thing #work")) .toBe(true);
    expect(matcher?.test("do thing #home")) .toBe(false);
  });

  it("formats task text by removing tag", () => {
    const matcher = buildTagMatchRegex("#work");
    const sharedMatcher = buildTagMatchRegex("#shared");
    expect(formatTaskTextForMessage("finish report #work", matcher)).toBe("finish report");
    expect(formatTaskTextForMessage("finish report #work #shared", matcher, [sharedMatcher])).toBe(
      "finish report"
    );
  });

  it("detects task line patterns", () => {
    expect(isUncheckedTaskLine("- [ ] todo")).toBe(true);
    expect(isTaskLine("- [x] done")).toBe(true);
    expect(isTaskLine("plain text")).toBe(false);
  });

  it("replaces checkbox when present", () => {
    expect(replaceCheckbox("- [ ] todo")).toBe("- [x] todo");
    expect(replaceCheckbox("no box")).toBeNull();
    expect(uncheckCheckbox("- [x] todo")).toBe("- [ ] todo");
  });

  it("detects completed task lines", () => {
    expect(isCompletedTaskLine("- [x] done")).toBe(true);
    expect(isCompletedTaskLine("- [ ] open")).toBe(false);
  });

  it("matches task line content", () => {
    const record = {
      id: "id",
      shortId: "short",
      text: "Write tests",
      path: null,
      line: null,
      raw: "- [ ] Write tests",
      priority: 0,
      dueTimestamp: null
    };
    expect(matchesTaskLine("- [ ] Write tests", record, true)).toBe(true);
    expect(matchesTaskLine("- [x] Write tests", record, true)).toBe(false);
  });

  it("parses priority from raw text", () => {
    expect(parsePriorityFromRaw("- [ ] task \u23EB")).toBe(4);
    expect(parsePriorityFromRaw("priority: high")) .toBe(3);
    expect(parsePriorityFromRaw("")) .toBeNull();
  });

  it("parses due dates from raw text", () => {
    const parsed = parseDueFromRaw("- [ ] task \uD83D\uDCC5 2024-12-31");
    expect(parsed).toBe(Date.UTC(2024, 11, 31));
  });

  it("derives task priority and due timestamps", () => {
    expect(getTaskPriority({ priority: "high" })).toBe(3);
    expect(getTaskDueTimestamp({ dueDate: "2024-05-06" })) .toBe(Date.UTC(2024, 4, 6));
  });

  it("builds a task line from input text", () => {
    const parsed = buildTaskLineFromInput("Buy milk due:2024-12-31 priority: high");
    expect(parsed.cleanedText).toBe("Buy milk");
    expect(parsed.lineText).toBe("- [ ] Buy milk \uD83D\uDD3C \uD83D\uDCC5 2024-12-31");
  });

  it("matches global tags from task metadata or raw", () => {
    const task = { tags: ["work"] };
    const record = {
      id: "id",
      shortId: "short",
      text: "Do thing",
      path: null,
      line: null,
      raw: "- [ ] Do thing #work",
      priority: 0,
      dueTimestamp: null
    };
    expect(taskMatchesGlobalTag(task, record, "#work")).toBe(true);
    expect(taskMatchesGlobalTag(task, record, "#home")).toBe(false);
  });

  it("creates a task record with derived fields", () => {
    const record = toTaskRecord({
      description: "Write docs",
      path: "Notes.md",
      line: 2,
      raw: "- [ ] Write docs"
    });
    expect(record.text).toBe("Write docs");
    expect(record.path).toBe("Notes.md");
    expect(record.line).toBe(2);
    expect(record.shortId.length).toBe(8);
  });

  it("detects completed tasks", () => {
    expect(isTaskCompleted({ completed: true })).toBe(true);
    expect(isTaskCompleted({ raw: "- [x] done" })).toBe(true);
    expect(isTaskCompleted({ raw: "- [ ] todo" })).toBe(false);
  });

  it("gets task text with fallback", () => {
    expect(getTaskText({ task: "hello" })).toBe("hello");
    expect(getTaskText({})) .toBe("(unnamed task)");
  });

  it("parses recurrence tags from raw text", () => {
    expect(parseRecurrenceFromRaw("- [ ] Pay rent #recur/1mo")).toEqual({ value: 1, unit: "mo" });
    expect(parseRecurrenceFromRaw("- [ ] Water plants #recur/2d")).toEqual({ value: 2, unit: "d" });
    expect(parseRecurrenceFromRaw("- [ ] Invalid #recur/0d")).toBeNull();
    expect(parseRecurrenceFromRaw("- [ ] Invalid #recur/3y")).toBeNull();
  });

  it("handles recurring completion tags", () => {
    const tagged = upsertRecurringCompletedTag("- [x] Pay rent #recur/1mo", 1700000000000);
    expect(tagged).toContain("#recurdone/1700000000000");
    expect(getRecurringCompletedAt(tagged)).toBe(1700000000000);
    const stripped = stripRecurringCompletedTag(tagged);
    expect(stripped).not.toContain("#recurdone/");
  });

  it("computes next recurrence timestamp for calendar months", () => {
    const completedAt = new Date(2024, 0, 31, 8, 30, 0, 0).getTime();
    const next = getRecurrenceNextTimestamp(completedAt, { value: 1, unit: "mo" });
    const date = new Date(next);
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(1);
    expect(date.getDate()).toBe(29);
    expect(date.getHours()).toBe(8);
    expect(date.getMinutes()).toBe(30);
  });

  it("determines whether recurring task is due", () => {
    const completedAt = Date.UTC(2024, 0, 1, 0, 0, 0);
    expect(isRecurringTaskDue(completedAt, { value: 1, unit: "d" }, completedAt + 24 * 60 * 60 * 1000)).toBe(true);
    expect(isRecurringTaskDue(completedAt, { value: 1, unit: "d" }, completedAt + 23 * 60 * 60 * 1000)).toBe(false);
  });
});
