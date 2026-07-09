/**
 * Property tests for the pure Phase-2 modules (design §2.6 build order,
 * steps 1–2): deterministic ids and the tool-pairing repair-on-read pass.
 *
 * The pairing properties mirror what Codex tests for its normalization
 * pass: for arbitrary trims, the output is (a) well-paired, (b) idempotent,
 * (c) deterministic, and (d) composes with orphan-result trims.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as AI from "@/AI/index.ts";

// ─── fixtures ────────────────────────────────────────────────────

const assistant = (
  parts: ReadonlyArray<Prompt.AssistantMessagePart>,
): Prompt.Message => Prompt.makeMessage("assistant", { content: [...parts] });

const toolMsg = (
  parts: ReadonlyArray<Prompt.ToolMessagePart>,
): Prompt.Message => Prompt.makeMessage("tool", { content: [...parts] });

const user = (text: string): Prompt.Message =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text })],
  });

const call = (id: string, providerExecuted = false) =>
  Prompt.makePart("tool-call", {
    id,
    name: "bash",
    params: { command: "bun test" },
    providerExecuted,
  });

const result = (id: string, isFailure = false) =>
  Prompt.makePart("tool-result", {
    id,
    name: "bash",
    isFailure,
    result: isFailure ? "boom" : "ok",
  });

const allParts = (messages: ReadonlyArray<Prompt.Message>) =>
  messages.flatMap((m) => m.content as ReadonlyArray<{ type: string } & any>);

const isWellPaired = (messages: ReadonlyArray<Prompt.Message>): boolean => {
  const parts = allParts(messages);
  const calls = parts.filter(
    (p) => p.type === "tool-call" && !p.providerExecuted,
  );
  const results = parts.filter((p) => p.type === "tool-result");
  const resultIds = new Set(results.map((r) => r.id));
  return (
    calls.every((c) => resultIds.has(c.id)) &&
    results.every((r) => calls.some((c) => c.id === r.id))
  );
};

// ─── pairing repair ──────────────────────────────────────────────

describe("repairToolPairing", () => {
  it("well-paired input passes through unchanged", () => {
    const messages = [
      user("run the tests"),
      assistant([call("c1")]),
      toolMsg([result("c1")]),
    ];
    expect(AI.repairToolPairing(messages)).toEqual(messages);
  });

  it("orphaned calls get synthetic failed results immediately after", () => {
    const messages = [user("go"), assistant([call("c1"), call("c2")])];
    const repaired = AI.repairToolPairing(messages);
    expect(isWellPaired(repaired)).toBe(true);
    // inserted right after the calling message
    expect(repaired[2]!.role).toBe("tool");
    const synthetic = allParts([repaired[2]!]);
    expect(synthetic.map((p) => p.id)).toEqual(["c1", "c2"]);
    for (const part of synthetic) {
      expect(part.isFailure).toBe(true);
      expect(part.result).toBe(AI.SYNTHETIC_ABORTED);
    }
  });

  it("provider-executed calls are exempt (deferred results are legal)", () => {
    const messages = [user("search"), assistant([call("web1", true)])];
    expect(AI.repairToolPairing(messages)).toEqual(messages);
  });

  it("orphaned results (trimmed calls) are dropped, empty messages removed", () => {
    const messages = [user("go"), toolMsg([result("ghost")])];
    const repaired = AI.repairToolPairing(messages);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.role).toBe("user");
    expect(isWellPaired(repaired)).toBe(true);
  });

  it("approval parts are stripped (the G1 landmine defense)", () => {
    const messages = [
      user("delete it"),
      assistant([
        call("c1"),
        Prompt.makePart("tool-approval-request", {
          approvalId: "a1",
          toolCallId: "c1",
        }),
      ]),
      toolMsg([
        Prompt.makePart("tool-approval-response", {
          approvalId: "a1",
          approved: true,
        }),
        result("c1"),
      ]),
    ];
    const repaired = AI.repairToolPairing(messages);
    const parts = allParts(repaired);
    expect(parts.some((p) => p.type === "tool-approval-request")).toBe(false);
    expect(parts.some((p) => p.type === "tool-approval-response")).toBe(false);
    expect(isWellPaired(repaired)).toBe(true);
  });

  it("is idempotent and deterministic under arbitrary trims", () => {
    const full = [
      user("go"),
      assistant([call("c1"), call("c2")]),
      toolMsg([result("c1")]),
      assistant([call("c3", true), call("c4")]),
      toolMsg([result("c4", true), result("zombie")]),
      user("and then?"),
      assistant([call("c5")]),
    ];
    // every prefix/suffix/element-dropped trim of the history
    const trims: Prompt.Message[][] = [];
    for (let start = 0; start < full.length; start++) {
      for (let end = start + 1; end <= full.length; end++) {
        trims.push(full.slice(start, end));
      }
    }
    for (let drop = 0; drop < full.length; drop++) {
      trims.push(full.filter((_, i) => i !== drop));
    }
    for (const trimmed of trims) {
      const once = AI.repairToolPairing(trimmed);
      expect(isWellPaired(once)).toBe(true); // (a) well-paired
      expect(AI.repairToolPairing(once)).toEqual(once); // (b) idempotent
      expect(AI.repairToolPairing(trimmed)).toEqual(once); // (c) deterministic
    }
  });
});

// ─── deterministic ids ───────────────────────────────────────────

describe("Ids", () => {
  it("command and event ids derive from position, replay-stable", () => {
    expect(AI.commandId("hash:issue-42", 3, 0)).toBe("cmd:hash:issue-42:3:0");
    expect(AI.eventId("cmd:s:3:0", "call", "tool_1")).toBe(
      "cmd:s:3:0:call:tool_1",
    );
    expect(AI.eventId("cmd:s:3:0", "finish")).toBe("cmd:s:3:0:finish");
  });

  it("the deterministic IdGenerator yields the same sequence per position", () => {
    const sequence = (n: number) =>
      Effect.gen(function* () {
        const generate = AI.deterministicIdGenerator("s", 7);
        const ids: string[] = [];
        for (let i = 0; i < n; i++) ids.push(yield* generate.generateId());
        return ids;
      }).pipe(Effect.runSync);
    expect(sequence(3)).toEqual(["gen:s:7:0", "gen:s:7:1", "gen:s:7:2"]);
    expect(sequence(3)).toEqual(sequence(3));
  });
});
