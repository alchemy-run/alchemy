/**
 * THE STATE MACHINE, PINNED — the pure `transition` matrix TasksDO
 * validates every hop with. Exhaustive: every (current, next) pair is
 * asserted, so a matrix edit is a deliberate diff here, never an
 * accident.
 */
import { describe, expect, test } from "bun:test";
import {
  eventKindOf,
  isTaskState,
  TASK_STATES,
  transition,
  type TaskState,
} from "../../src/tasks/TasksDO.ts";

/** The whole legal matrix, spelled out. */
const LEGAL: Record<TaskState, ReadonlyArray<TaskState>> = {
  inbox: ["ready", "dropped"],
  ready: ["working", "inbox", "parked", "dropped"],
  working: ["review", "ready", "parked", "done", "inbox", "dropped"],
  review: ["working", "ready", "done", "parked", "dropped"],
  parked: ["ready", "inbox", "dropped"],
  done: [],
  dropped: [],
};

describe("transition", () => {
  test("every pair matches the declared matrix", () => {
    const wrong: string[] = [];
    for (const current of TASK_STATES) {
      for (const next of TASK_STATES) {
        if (transition(current, next) !== LEGAL[current].includes(next)) {
          wrong.push(`${current} → ${next}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("no state may transition to itself", () => {
    for (const state of TASK_STATES) {
      expect(transition(state, state)).toBe(false);
    }
  });

  test("done and dropped are terminal", () => {
    for (const next of TASK_STATES) {
      expect(transition("done", next)).toBe(false);
      expect(transition("dropped", next)).toBe(false);
    }
  });

  test("the desk loop's happy path is legal end to end", () => {
    // file → route → claim → complete → review claimed → approved
    expect(transition("inbox", "ready")).toBe(true);
    expect(transition("ready", "working")).toBe(true);
    expect(transition("working", "review")).toBe(true);
    expect(transition("review", "working")).toBe(true);
    expect(transition("working", "done")).toBe(true);
  });

  test("the bounce path is legal: changes requested re-readies", () => {
    expect(transition("working", "ready")).toBe(true);
    expect(transition("ready", "working")).toBe(true);
  });

  test("park and handoff are legal from a working desk", () => {
    expect(transition("working", "parked")).toBe(true);
    expect(transition("working", "inbox")).toBe(true);
    expect(transition("parked", "ready")).toBe(true);
  });
});

describe("isTaskState / eventKindOf", () => {
  test("guards the wire's state strings", () => {
    for (const state of TASK_STATES) expect(isTaskState(state)).toBe(true);
    expect(isTaskState("bogus")).toBe(false);
    expect(isTaskState("")).toBe(false);
  });

  test("every state has a default timeline kind", () => {
    for (const state of TASK_STATES) {
      expect(eventKindOf(state).length).toBeGreaterThan(0);
    }
  });
});
