import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { SessionEvent } from "@/AI/Session.ts";
import { toUIMessageStream } from "@/AI/UIMessageStream.ts";

const base = { sessionId: "s", at: 0 };
const events: SessionEvent[] = [
  { ...base, cursor: 1, type: "turn.started", turnId: "t1" },
  { ...base, cursor: 2, type: "reasoning.delta", itemId: "r1", text: "thinking" },
  { ...base, cursor: 3, type: "message.delta", itemId: "m1", role: "assistant", text: "Hel" },
  { ...base, cursor: 4, type: "message.delta", itemId: "m1", role: "assistant", text: "lo" },
  {
    ...base,
    cursor: 5,
    type: "tool.started",
    itemId: "x1",
    tool: { kind: "edit", title: "Edit a.ts", name: "Edit", input: { file: "a.ts" } },
  },
  {
    ...base,
    cursor: 6,
    type: "tool.completed",
    itemId: "x1",
    status: "ok",
    content: [{ type: "diff", path: "a.ts", newText: "x" }],
  },
  {
    ...base,
    cursor: 7,
    type: "turn.completed",
    turnId: "t1",
    result: {
      turnId: "t1",
      status: "completed",
      message: [{ type: "text", text: "Hello" }],
      usage: { inputTokens: 1, outputTokens: 2 },
    },
  },
];

describe("AI.toUIMessageStream", { tags: ["unit", "local"] }, () => {
  test("maps a turn onto AI SDK UI message chunks", async () => {
    const chunks = Array.from(
      await Effect.runPromise(Stream.runCollect(toUIMessageStream(Stream.fromIterable(events)))),
    );
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "text-start",
      "text-delta",
      "text-delta",
      "tool-input-available",
      "tool-output-available",
      "data-diff",
      "reasoning-end",
      "text-end",
      "data-usage",
      "finish-step",
      "finish",
    ]);
    expect(chunks[7]).toMatchObject({ toolCallId: "x1", toolName: "Edit", dynamic: true });
  });
});
