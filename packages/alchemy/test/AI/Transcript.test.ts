import { describe, expect, test } from "alchemy-test";
import type { SessionEvent, SessionEventInput } from "@/AI/Session.ts";
import { emptyTranscript, reduceTranscript } from "@/AI/Transcript.ts";

let cursor = 0;
const stamp = (events: ReadonlyArray<SessionEventInput>): SessionEvent[] =>
  events.map(
    (e) => ({ ...e, sessionId: "s", cursor: ++cursor, at: 1000 + cursor }) as SessionEvent,
  );

const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.01 };

describe("AI.reduceTranscript", { tags: ["unit", "local"] }, () => {
  test("folds a session log into user and assistant messages with parts", () => {
    cursor = 0;
    const events = stamp([
      { type: "state", state: "idle" },
      { type: "model.changed", model: "haiku" },
      {
        type: "message.completed",
        itemId: "u1",
        role: "user",
        content: [{ type: "text", text: "list files" }],
      },
      { type: "turn.started", turnId: "t1" },
      { type: "reasoning.delta", itemId: "m1", text: "let me " },
      { type: "reasoning.delta", itemId: "m1", text: "look" },
      { type: "tool.started", itemId: "tool1", tool: { kind: "shell", title: "ls" } },
      { type: "tool.output", itemId: "tool1", chunk: "README\n" },
      {
        type: "tool.completed",
        itemId: "tool1",
        status: "ok",
        content: [{ type: "text", text: "README" }],
      },
      { type: "message.delta", itemId: "m1:0", role: "assistant", text: "There is " },
      { type: "message.delta", itemId: "m1:0", role: "assistant", text: "a README." },
      {
        type: "turn.completed",
        turnId: "t1",
        result: { turnId: "t1", status: "completed", message: [], usage },
      },
    ]);
    const t = events.reduce(reduceTranscript, emptyTranscript);

    expect(t.state).toBe("idle");
    expect(t.model).toBe("haiku");
    expect(t.cursor).toBe(events.length);
    expect(t.usage.costUsd).toBeCloseTo(0.01);
    expect(t.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const assistant = t.messages[1]!;
    expect(assistant.status).toBe("completed");
    expect(assistant.parts.map((p) => p.type)).toEqual(["reasoning", "tool", "text"]);
    expect(assistant.parts[0]).toMatchObject({ text: "let me look", streaming: false });
    expect(assistant.parts[1]).toMatchObject({ state: "ok", output: "README\n" });
    expect(assistant.parts[2]).toMatchObject({ text: "There is a README.", streaming: false });
  });

  test("a running turn streams; replayed events are ignored", () => {
    cursor = 0;
    const events = stamp([
      {
        type: "message.completed",
        itemId: "u1",
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
      { type: "turn.started", turnId: "t1" },
      { type: "message.delta", itemId: "x", role: "assistant", text: "he" },
    ]);
    const live = events.reduce(reduceTranscript, emptyTranscript);
    expect(live.state).toBe("running");
    expect(live.turnStartedAt).toBe(events[1]!.at);
    expect(live.messages[1]).toMatchObject({ status: "streaming" });
    // Reconnecting replays from an older cursor: no duplicated text.
    const again = events.reduce(reduceTranscript, live);
    expect(again.messages[1]!.parts[0]).toMatchObject({ text: "he", streaming: true });
  });
});
