import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { acpDriver } from "@/AI/AcpDriver.ts";
import { claudeCodeDriver } from "@/AI/ClaudeCodeDriver.ts";
import { codexDriver } from "@/AI/CodexDriver.ts";
import { makeHarness, type HarnessDriver } from "@/AI/HarnessEngine.ts";
import type { SessionError } from "@/AI/Session.ts";
import { MemorySessionStore } from "@/AI/SessionStore.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

/**
 * The native harness drivers against the real harness binaries, as local
 * processes (no container). Each runs one cheap turn and checks the
 * normalized event stream.
 */
const workdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "alchemy-harness-"));

const roundTrip = (
  driver: Effect.Effect<HarnessDriver, SessionError, any>,
  cwd: string,
  /** Switch to this model mid-session and run a second turn. */
  switchTo?: string,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(yield* driver);
    const session = yield* harness.start({ cwd });
    const turn = yield* session.prompt("Reply with exactly the word: pong");
    const result = yield* session.result(turn.turnId);
    let switched: { model: string | undefined; status: string } | undefined;
    if (switchTo !== undefined) {
      yield* session.setModel(switchTo);
      const second = yield* session.prompt("Reply with exactly the word: ping");
      switched = {
        model: (yield* session.info()).model,
        status: (yield* session.result(second.turnId)).status,
      };
    }
    yield* session.close();
    const events = Array.from(yield* Stream.runCollect(session.events()));
    const types = new Set(events.map((e) => e.type));
    // Streamed text for one turn's answer should group into few items, not
    // one per delta.
    const firstTurnEnd = events.findIndex((e) => e.type === "turn.completed");
    const answerItems = new Set(
      events
        .slice(0, firstTurnEnd)
        .flatMap((e) => (e.type === "message.delta" && e.role === "assistant" ? [e.itemId] : [])),
    ).size;
    return { result, types, switched, answerItems };
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(MemorySessionStore, RuntimeContext.phantom, NodeServices.layer)),
  );

describe("harness drivers (live, local processes)", { tags: ["live", "local"] }, () => {
  test.skipIf(!process.env.ANTHROPIC_API_KEY)(
    "Claude Code runs a turn through the Agent SDK",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { result, types, switched, answerItems } = yield* roundTrip(
            Effect.succeed(
              claudeCodeDriver({
                model: "claude-haiku-4-5-20251001",
                executable: process.env.CLAUDE_EXECUTABLE ?? "claude",
                env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
              }),
            ),
            workdir(),
            "haiku",
          );
          expect(result.status).toBe("completed");
          expect(JSON.stringify(result.message).toLowerCase()).toContain("pong");
          expect(result.usage.outputTokens).toBeGreaterThan(0);
          expect(switched).toEqual({ model: "haiku", status: "completed" });
          expect(answerItems).toBe(1);
          expect(types.has("message.delta")).toBe(true);
        }) as Effect.Effect<void>,
      ),
    { timeout: 120_000 },
  );

  test.skipIf(!process.env.ANTHROPIC_API_KEY || !process.env.OPENCODE_EXECUTABLE)(
    "an ACP agent (opencode acp) runs a turn",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { result, types, switched } = yield* roundTrip(
            acpDriver({
              name: "opencode",
              command: process.env.OPENCODE_EXECUTABLE!,
              args: ["acp"],
              env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
            }),
            workdir(),
            "anthropic/claude-haiku-4-5",
          );
          expect(result.status).toBe("completed");
          expect(JSON.stringify(result.message).toLowerCase()).toContain("pong");
          expect(types.has("message.delta")).toBe(true);
          expect(switched).toEqual({ model: "anthropic/claude-haiku-4-5", status: "completed" });
        }) as Effect.Effect<void>,
      ),
    { timeout: 120_000 },
  );

  test.skipIf(!process.env.OPENAI_API_KEY || !process.env.CODEX_LIVE)(
    "Codex runs a turn over codex app-server",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { result, types, switched } = yield* roundTrip(
            codexDriver({
              command: "npx",
              args: ["-y", "@openai/codex"],
              env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
            }),
            workdir(),
            "gpt-5-nano",
          );
          // A funded key completes with "pong"; an unfunded one fails the turn
          // with a quota error — either way the turn lifecycle round-trips.
          expect(["completed", "failed"]).toContain(result.status);
          if (result.status === "completed") {
            expect(JSON.stringify(result.message).toLowerCase()).toContain("pong");
          }
          expect(types.has("turn.started")).toBe(true);
          expect(switched?.model).toBe("gpt-5-nano");
        }) as Effect.Effect<void>,
      ),
    { timeout: 180_000 },
  );
});
