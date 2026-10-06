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

const roundTrip = (driver: Effect.Effect<HarnessDriver, SessionError, any>, cwd: string) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(yield* driver);
    const session = yield* harness.start({ cwd });
    const turn = yield* session.prompt("Reply with exactly the word: pong");
    const result = yield* session.result(turn.turnId);
    yield* session.close();
    const types = new Set(
      Array.from(yield* Stream.runCollect(session.events())).map((e) => e.type),
    );
    return { result, types };
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
          const { result, types } = yield* roundTrip(
            Effect.succeed(
              claudeCodeDriver({
                model: "claude-haiku-4-5-20251001",
                executable: process.env.CLAUDE_EXECUTABLE ?? "claude",
                env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
              }),
            ),
            workdir(),
          );
          expect(result.status).toBe("completed");
          expect(JSON.stringify(result.message).toLowerCase()).toContain("pong");
          expect(result.usage.outputTokens).toBeGreaterThan(0);
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
          const { result, types } = yield* roundTrip(
            acpDriver({
              name: "opencode",
              command: process.env.OPENCODE_EXECUTABLE!,
              args: ["acp"],
              env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
            }),
            workdir(),
          );
          expect(result.status).toBe("completed");
          expect(JSON.stringify(result.message).toLowerCase()).toContain("pong");
          expect(types.has("message.delta")).toBe(true);
        }) as Effect.Effect<void>,
      ),
    { timeout: 120_000 },
  );
});
