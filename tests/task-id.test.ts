import { describe, expect, it } from "bun:test";
import {
  TASK_ID_TAG_PREFIX,
  buildTaskIdTagRegex,
  buildTaskIdTagRegexForId,
  ensureTaskIdTag,
  getStoredTaskId,
  hashTaskId,
  stripTaskIdTag
} from "../task-id";

describe("task-id", () => {
  it("buildTaskIdTagRegex matches tag tokens", () => {
    const regex = buildTaskIdTagRegex("i");
    expect(regex.test("do thing #taskid/abc123")).toBe(true);
    expect(regex.test("#taskid/abc123.")).toBe(true);
    expect(regex.test("#taskid/abc123z")).toBe(false);
  });

  it("buildTaskIdTagRegexForId matches exact id", () => {
    const regex = buildTaskIdTagRegexForId("abc123", "i");
    expect(regex.test("task #taskid/abc123")).toBe(true);
    expect(regex.test("task #taskid/abc124")).toBe(false);
  });

  it("getStoredTaskId returns normalized id", () => {
    expect(getStoredTaskId("todo #taskid/ABC123")).toBe("abc123");
    expect(getStoredTaskId("todo")).toBeNull();
  });

  it("stripTaskIdTag removes tag but keeps text", () => {
    expect(stripTaskIdTag("todo #taskid/abc123")).toBe("todo");
    expect(stripTaskIdTag("todo")) .toBe("todo");
  });

  it("ensureTaskIdTag adds tag once", () => {
    const id = "abc123";
    const tagged = ensureTaskIdTag("task", id);
    expect(tagged).toBe(`task ${TASK_ID_TAG_PREFIX}${id}`);
    expect(ensureTaskIdTag(tagged, id)).toBe(tagged);
  });

  it("hashTaskId is stable and length-sensitive", () => {
    const a = hashTaskId("alpha");
    const b = hashTaskId("alpha");
    const c = hashTaskId("alpha!");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
