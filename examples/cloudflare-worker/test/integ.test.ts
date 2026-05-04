import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "integ",
  Effect.gen(function* () {
    const { url } = yield* stack;

    expect(url).toBeString();
  }),
);

/**
 * Regression guard for https://github.com/alchemy-run/alchemy-effect/pull/71
 *
 * `NotifyWorkflow` accesses `Cloudflare.WorkerEnvironment` inside its body and
 * performs a KV roundtrip via `env.KV.put` / `env.KV.get`. If the fix from #71
 * is ever reverted, the body Effect loses the `WorkerEnvironment` service and
 * dies with `Service not found: Cloudflare.Workers.WorkerEnvironment` on the
 * first `yield* Cloudflare.WorkerEnvironment` — the workflow instance never
 * reaches `complete`, and this test times out or surfaces the `errored` status.
 */
test(
  "workflow body can access WorkerEnvironment and exercise env bindings",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const roomId = `smoke-${Date.now()}`;

    // Start the workflow instance.
    const startResponse = yield* Effect.tryPromise({
      try: () => fetch(`${url}/workflow/start/${roomId}`, { method: "POST" }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });
    expect(startResponse.status).toBe(200);

    const { instanceId } = yield* Effect.tryPromise({
      try: () => startResponse.json() as Promise<{ instanceId: string }>,
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });
    expect(instanceId).toBeString();

    // Poll status until complete / errored / timeout (~60s).
    const deadline = Date.now() + 60_000;
    let lastStatus:
      | { status: string; output?: unknown; error?: unknown }
      | undefined;
    while (Date.now() < deadline) {
      const statusResponse = yield* Effect.tryPromise({
        try: () => fetch(`${url}/workflow/status/${instanceId}`),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
      expect(statusResponse.status).toBe(200);
      lastStatus = yield* Effect.tryPromise({
        try: () =>
          statusResponse.json() as Promise<{
            status: string;
            output?: unknown;
            error?: unknown;
          }>,
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
      if (lastStatus.status === "complete" || lastStatus.status === "errored") {
        break;
      }
      yield* Effect.sleep("2 seconds");
    }

    // The workflow must have completed — if WorkerEnvironment provision breaks,
    // the body dies on the first yield and the instance never reaches complete.
    expect(lastStatus).toBeDefined();
    expect(lastStatus!.status).toBe("complete");
    expect(lastStatus!.error).toBeFalsy();
  }),
  { timeout: 120_000 },
);
