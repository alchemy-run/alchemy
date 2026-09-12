/**
 * `observationSpan` — the redaction span behind one UIMessage. It must
 * group the log EXACTLY as `toUIMessages` does: `u-<seq>` is the one
 * input, `a-<seq>` is the whole burst (its samplings, tool results,
 * and the dispatched markers that preceded it), `crash-<seq>` the one
 * crash, and `settled` rows are never part of any span.
 */
import type { SessionObservation } from "@/AI/Events.ts";
import {
  makeChunkTranslator,
  observationSpan,
  STOPPED_TEXT,
  toUIMessages,
} from "@/AI/UIMessage.ts";
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

/**
 * The operator's stop (`aborted`): the burst it cut short WEARS it —
 * snapshot and live agree — and a stop before anything sampled stands
 * alone; either way the next sampling is a fresh message.
 */
describe("aborted", () => {
  const cut: Array<SessionObservation> = [
    { ...base, type: "input", seq: 0, text: "go" },
    {
      ...base,
      type: "assistant",
      seq: 1,
      tick: 0,
      ms: 1,
      text: "",
      toolCalls: [{ id: "call-1", name: "worktree", input: {} }],
    },
    { ...base, type: "aborted", seq: 2, by: "operator" },
    { ...base, type: "parked", seq: 3 },
    { ...base, type: "input", seq: 4, text: "again" },
    { ...base, type: "aborted", seq: 5, by: "operator" },
    { ...base, type: "input", seq: 6, text: "once more" },
    {
      ...base,
      type: "assistant",
      seq: 7,
      tick: 1,
      ms: 1,
      text: "back",
      toolCalls: [],
    },
  ] as Array<SessionObservation>;

  it("the snapshot marks the cut burst; a bare stop is its own row", () => {
    const messages = toUIMessages(cut);
    expect(messages.map((message) => message.id)).toEqual([
      "u-0",
      "a-1",
      "u-4",
      "abort-5",
      "u-6",
      "a-7",
    ]);
    expect((messages[1]!.metadata as { aborted?: boolean }).aborted).toBe(true);
    // the call the stop cut short is CLOSED, not running forever: the
    // round that owed its result is over
    expect(messages[1]!.parts[1]).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "call-1",
      state: "output-error",
      errorText: STOPPED_TEXT,
    });
    expect(messages[3]!.parts).toEqual([]);
    expect((messages[3]!.metadata as { aborted?: boolean }).aborted).toBe(true);
    expect(messages[5]!.metadata).not.toHaveProperty("aborted");
  });

  it("spans follow the same grouping", () => {
    expect(observationSpan(cut, "a-1")).toEqual([1, 2]);
    expect(observationSpan(cut, "abort-5")).toEqual([5]);
    expect(observationSpan(cut, "a-7")).toEqual([7]);
    for (const message of toUIMessages(cut)) {
      expect(observationSpan(cut, message.id).length).toBeGreaterThan(0);
    }
  });

  it("live: the stop finishes the turn with the same metadata", () => {
    const translate = makeChunkTranslator();
    const opened = translate(cut[1]!);
    expect(opened.done).toBe(false);
    const stopped = translate(cut[2]!);
    expect(stopped.done).toBe(true);
    // the open call is closed on the wire too, before the step ends
    expect(stopped.chunks.map((chunk) => chunk.type)).toEqual([
      "tool-output-error",
      "finish-step",
      "finish",
    ]);
    expect(stopped.chunks[0]).toMatchObject({
      toolCallId: "call-1",
      errorText: STOPPED_TEXT,
    });
    expect(stopped.chunks.at(-1)).toMatchObject({
      messageMetadata: { aborted: true },
    });
    // a stop before anything sampled still yields a complete message
    const bare = makeChunkTranslator()(cut[5]!);
    expect(bare.done).toBe(true);
    expect(bare.chunks.map((chunk) => chunk.type)).toEqual(["start", "finish"]);
  });
});

/**
 * An in-flight tool call is a DURABLE row: the sampling streamed the
 * call, its handler is running (a spawned engineer, for minutes), and
 * the `assistant` row that restates it has not landed. A snapshot
 * taken in that window shows the call; the restatement joins it.
 */
describe("in-flight tool calls", () => {
  const spawning: Array<SessionObservation> = [
    { ...base, type: "input", seq: 0, text: "review the five PRs" },
    {
      ...base,
      type: "tool-call",
      seq: 1,
      tick: 0,
      toolCallId: "call-a",
      toolName: "spawn",
      input: { brief: "one" },
    },
    {
      ...base,
      type: "tool-call",
      seq: 2,
      tick: 0,
      toolCallId: "call-b",
      toolName: "spawn",
      input: { brief: "two" },
    },
  ] as Array<SessionObservation>;
  const landed: Array<SessionObservation> = [
    ...spawning,
    {
      ...base,
      type: "assistant",
      seq: 3,
      tick: 0,
      ms: 1,
      text: "Spawning two engineers.",
      toolCalls: [
        { id: "call-a", name: "spawn", input: { brief: "one" } },
        { id: "call-b", name: "spawn", input: { brief: "two" } },
      ],
    },
    {
      ...base,
      type: "tool-result",
      seq: 4,
      toolCallId: "call-a",
      toolName: "spawn",
      output: { agent: "e-1" },
      isFailure: false,
    },
  ] as Array<SessionObservation>;

  it("the snapshot shows every call whose handler is still running", () => {
    const messages = toUIMessages(spawning);
    expect(messages.map((message) => message.id)).toEqual(["u-0", "a-1"]);
    const tools = messages[1]!.parts.filter(
      (part) => part.type === "dynamic-tool",
    );
    expect(tools.map((part) => (part as any).toolCallId)).toEqual([
      "call-a",
      "call-b",
    ]);
    expect(
      tools.every((part) => (part as any).state === "input-available"),
    ).toBe(true);
  });

  it("the restatement joins the step — one part per call, prose first", () => {
    const messages = toUIMessages(landed);
    expect(messages.map((message) => message.id)).toEqual(["u-0", "a-1"]);
    const parts = messages[1]!.parts;
    expect(parts.map((part) => part.type)).toEqual([
      "step-start",
      "text",
      "dynamic-tool",
      "dynamic-tool",
    ]);
    expect((parts[2] as any).state).toBe("output-available");
    expect((parts[3] as any).state).toBe("input-available");
  });

  it("spans name the burst by the row that opened it", () => {
    expect(observationSpan(landed, "a-1")).toEqual([1, 2, 3, 4]);
    expect(observationSpan(landed, "a-3")).toEqual([]);
    for (const message of toUIMessages(landed)) {
      expect(observationSpan(landed, message.id).length).toBeGreaterThan(0);
    }
  });

  /**
   * The session ENDS with the calls still open (`Sessions.stop`, the
   * supervision cascade, a delete's settle): the round is cut and no
   * `tool-result` will ever land — the projection closes the calls, or
   * a spawn card would say "working" over a session that is gone.
   */
  it("a settle closes the calls the cut round still owed — snapshot and live", () => {
    const settled: Array<SessionObservation> = [
      ...landed,
      { ...base, type: "settled", seq: 5 },
    ] as Array<SessionObservation>;
    const parts = toUIMessages(settled)[1]!.parts as Array<any>;
    // the answered call keeps its answer; the open one is closed
    expect(parts[2].state).toBe("output-available");
    expect(parts[3]).toMatchObject({
      toolCallId: "call-b",
      state: "output-error",
      errorText: STOPPED_TEXT,
    });

    const translate = makeChunkTranslator();
    for (const observation of landed.slice(1)) translate(observation);
    const end = translate(settled[5]!);
    expect(end.done).toBe(true);
    expect(end.chunks.map((chunk) => chunk.type)).toEqual([
      "tool-output-error",
      "finish-step",
      "finish",
    ]);
    expect(end.chunks[0]).toMatchObject({ toolCallId: "call-b" });
  });
});

describe("model + usage", () => {
  // one burst, two samplings: the first calls a tool, the second
  // answers — each with its own bill, both with the same model
  const billed: Array<SessionObservation> = [
    { ...base, type: "input", seq: 0, text: "go" },
    {
      ...base,
      type: "assistant",
      seq: 1,
      tick: 0,
      ms: 1,
      text: "",
      toolCalls: [{ id: "call-1", name: "search", input: {} }],
      model: "gpt-5",
      usage: { input: 100, cacheRead: 40, output: 10 },
    },
    {
      ...base,
      type: "tool-result",
      seq: 2,
      toolCallId: "call-1",
      toolName: "search",
      output: "ok",
      isFailure: false,
    },
    {
      ...base,
      type: "assistant",
      seq: 3,
      tick: 1,
      ms: 1,
      text: "done",
      toolCalls: [],
      model: "gpt-5",
      usage: { input: 120, output: 30, reasoning: 5 },
    },
    // a burst whose model reported nothing carries neither key
    { ...base, type: "input", seq: 4, text: "again" },
    {
      ...base,
      type: "assistant",
      seq: 5,
      tick: 2,
      ms: 1,
      text: "ok",
      toolCalls: [],
    },
  ];

  it("the snapshot stamps the burst's model and its summed bill", () => {
    const messages = toUIMessages(billed);
    expect(messages[1]!.metadata).toMatchObject({
      model: "gpt-5",
      usage: { input: 220, cacheRead: 40, output: 40, reasoning: 5 },
    });
    expect(messages[3]!.metadata).not.toHaveProperty("model");
    expect(messages[3]!.metadata).not.toHaveProperty("usage");
  });

  it("live: the finish carries the same metadata", () => {
    const translate = makeChunkTranslator();
    let finish: unknown;
    for (const observation of billed.slice(1, 4)) {
      for (const chunk of translate(observation).chunks) {
        if (chunk.type === "finish") finish = chunk;
      }
    }
    expect(finish).toMatchObject({
      type: "finish",
      messageMetadata: {
        model: "gpt-5",
        usage: { input: 220, cacheRead: 40, output: 40, reasoning: 5 },
      },
    });
  });
});
