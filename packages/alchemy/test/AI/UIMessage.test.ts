/**
 * `observationSpan` — the redaction span behind one UIMessage. It must
 * group the log EXACTLY as `toUIMessages` does: `u-<seq>` is the one
 * input, `a-<seq>` is the whole burst (its samplings, tool results,
 * and the dispatched markers that preceded it), `crash-<seq>` the one
 * crash, and `settled` rows are never part of any span.
 */
import type { SessionObservation } from "@/AI/Events.ts";
import { observationSpan, toUIMessages } from "@/AI/UIMessage.ts";
import { describe, expect, it } from "alchemy-test";

const base = { term: "TestAgent", key: "k", at: 0 };

const log: Array<SessionObservation> = [
  { ...base, type: "input", seq: 0, text: "first question" },
  {
    ...base,
    type: "assistant",
    seq: 1,
    tick: 0,
    ms: 1,
    text: "hi",
    toolCalls: [],
  },
  { ...base, type: "input", seq: 2, text: "use a tool" },
  // a delegation observed mid-sampling, before its burst's assistant
  {
    ...base,
    type: "dispatched",
    seq: 3,
    toolName: "spawn",
    agent: "Engineer",
    child: "c1",
  },
  {
    ...base,
    type: "assistant",
    seq: 4,
    tick: 1,
    ms: 1,
    text: "",
    toolCalls: [{ id: "call-1", name: "spawn", input: {} }],
  },
  {
    ...base,
    type: "tool-result",
    seq: 5,
    toolCallId: "call-1",
    toolName: "spawn",
    output: "ok",
    isFailure: false,
  },
  {
    ...base,
    type: "assistant",
    seq: 6,
    tick: 2,
    ms: 1,
    text: "done",
    toolCalls: [],
  },
  { ...base, type: "input", seq: 7, text: "third question" },
  { ...base, type: "settled", seq: 8, outcome: "bye" },
] as Array<SessionObservation>;

describe("observationSpan", () => {
  it("a user message is its one input row", () => {
    expect(observationSpan(log, "u-0")).toEqual([0]);
    expect(observationSpan(log, "u-2")).toEqual([2]);
    expect(observationSpan(log, "u-7")).toEqual([7]);
  });

  it("an assistant message takes its whole burst", () => {
    expect(observationSpan(log, "a-1")).toEqual([1]);
    // the burst: the dispatched marker, both samplings, the result
    expect(observationSpan(log, "a-4")).toEqual([3, 4, 5, 6]);
  });

  it("spans exist exactly for the ids toUIMessages renders", () => {
    for (const message of toUIMessages(log)) {
      expect(observationSpan(log, message.id).length).toBeGreaterThan(0);
    }
  });

  it("unknown ids and settled rows answer empty", () => {
    expect(observationSpan(log, "a-99")).toEqual([]);
    expect(observationSpan(log, "u-8")).toEqual([]);
    expect(observationSpan(log, "nonsense")).toEqual([]);
  });
});
