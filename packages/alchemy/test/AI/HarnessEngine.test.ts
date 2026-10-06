import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeHarness, type HarnessDriver } from "@/AI/HarnessEngine.ts";
import { emptyUsage, type Capabilities } from "@/AI/Session.ts";
import { HarnessRpcs, remoteHarness, serveHarness } from "@/AI/SessionRpcs.ts";
import { MemorySessionStore } from "@/AI/SessionStore.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

const capabilities: Capabilities = {
  steering: "interrupt-restart",
  queuedPrompts: false,
  fork: false,
  rollback: false,
  subagents: false,
  plans: false,
  reasoning: false,
};

/**
 * A fake harness: echoes the prompt back as one assistant message. Prompts
 * containing "hang" never finish on their own — only `interrupt` ends them.
 */
const echoDriver: Effect.Effect<HarnessDriver> = Effect.sync(() => ({
  name: "echo",
  capabilities,
  defaultCwd: "/workspace",
  open: (options) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const current = yield* Ref.make<string | undefined>(undefined);
      const finish = (turnId: string, status: "completed" | "interrupted", text: string) =>
        options.emit({
          type: "turn.completed",
          turnId,
          result: {
            turnId,
            status,
            message: [{ type: "text", text }],
            usage: { ...emptyUsage, outputTokens: text.length },
          },
        });
      return {
        prompt: (turnId, prompt) =>
          Effect.gen(function* () {
            const text = prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
            yield* Ref.set(current, turnId);
            yield* options.emit({ type: "turn.started", turnId });
            yield* options.emit({ type: "message.delta", itemId: turnId, role: "assistant", text });
            if (!text.includes("hang")) {
              yield* finish(turnId, "completed", `echo: ${text}`).pipe(Effect.forkIn(scope));
            }
          }),
        interrupt: () =>
          Ref.get(current).pipe(
            Effect.flatMap((turnId) => (turnId ? finish(turnId, "interrupted", "") : Effect.void)),
          ),
        respond: () => Effect.void,
      };
    }),
}));

const harness = Effect.flatMap(echoDriver, makeHarness);

const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(MemorySessionStore, RuntimeContext.phantom)),
    ) as Effect.Effect<A, E, never>,
  );

describe("AI.makeHarness", { tags: ["unit", "local"] }, () => {
  test("a turn runs start → prompt → result, with the events logged in order", async () => {
    const out = await run(
      Effect.gen(function* () {
        const h = yield* harness;
        const session = yield* h.start({ id: "s1" });
        const turn = yield* session.prompt("hello");
        const result = yield* session.result(turn.turnId);
        const info = yield* session.info();
        yield* session.close();
        const types = Array.from(yield* Stream.runCollect(session.events())).map((e) => e.type);
        return { result, info, types };
      }),
    );
    expect(out.result.status).toBe("completed");
    expect(out.result.message).toEqual([{ type: "text", text: "echo: hello" }]);
    expect(out.info.state).toBe("idle");
    expect(out.info.usage.outputTokens).toBe("echo: hello".length);
    expect(out.types).toEqual([
      "state",
      "turn.started",
      "message.delta",
      "turn.completed",
      "state",
    ]);
  });

  test("start is idempotent by id", async () => {
    const same = await run(
      Effect.gen(function* () {
        const h = yield* harness;
        const a = yield* h.start({ id: "same" });
        const b = yield* h.start({ id: "same" });
        return a === b;
      }),
    );
    expect(same).toBe(true);
  });

  test("steering without native support interrupts and restarts", async () => {
    const out = await run(
      Effect.gen(function* () {
        const h = yield* harness;
        const session = yield* h.start({ id: "s2" });
        const first = yield* session.prompt("please hang");
        yield* session.steer("do this instead");
        const interrupted = yield* session.result(first.turnId);
        const latest = yield* session.result();
        return { interrupted: interrupted.status, latest: latest.message };
      }),
    );
    expect(out.interrupted).toBe("interrupted");
    expect(out.latest).toEqual([{ type: "text", text: "echo: do this instead" }]);
  });

  test("fork without native support fails with Unsupported", async () => {
    const tag = await run(
      Effect.gen(function* () {
        const h = yield* harness;
        const session = yield* h.start();
        return yield* session
          .fork()
          .pipe(Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "ok" }));
      }),
    );
    expect(tag).toBe("Unsupported");
  });

  test("a harness served over HarnessRpcs drives identically through remoteHarness", async () => {
    const out = await run(
      Effect.gen(function* () {
        const local = yield* harness;
        const client = yield* RpcTest.makeClient(HarnessRpcs).pipe(
          Effect.provide(serveHarness(local)),
        );
        const remote = yield* remoteHarness(client);
        const session = yield* remote.start({ id: "r1" });
        const turn = yield* session.prompt("over rpc");
        const result = yield* session.result(turn.turnId);
        const sessions = yield* remote.list();
        return { name: remote.name, result, count: sessions.length };
      }),
    );
    expect(out.name).toBe("echo");
    expect(out.result.message).toEqual([{ type: "text", text: "echo: over rpc" }]);
    expect(out.count).toBe(1);
  });
});
