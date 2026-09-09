import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (error) => error instanceof WorkerNotReady,
        schedule: Schedule.exponential("250 millis"),
        times: 20,
      }),
    );
  }).pipe(Effect.orDie);

/**
 * A producer binding for a queue nothing consumes makes the worker subscribe
 * to the dev registry (it has to find whichever instance consumes the queue),
 * which in turn gives it a registry-proxy service it would not otherwise
 * have. That must not disturb how OTHER workers reach it: the caller's
 * service binding resolves the target through the same registry.
 *
 * Both workers run in this process here, so this covers the in-process wiring
 * only — the cross-process path (`alchemy dev` runs a Vite website's workerd
 * in a child process) is pinned by the registry's own tests.
 */
test.provider(
  "service binding reaches a worker that produces to an unconsumed queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("ProducerOnlyQueue");
          const target = yield* Cloudflare.Worker("producer-target", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/producer-target-worker.ts",
            ),
            env: { QUEUE: queue },
          });
          const caller = yield* Cloudflare.Worker("producer-caller", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/producer-caller-worker.ts",
            ),
            env: { BACKEND: target },
          });
          return { target, caller };
        }),
      );

      expect(deployed.caller.url).toMatch(/^http:\/\/localhost:\d+$/);

      const direct = yield* getReady(`${deployed.target.url}/ping`).pipe(
        Effect.flatMap((res) => res.text),
      );
      expect(direct).toBe("pong from target");

      const viaBinding = yield* getReady(
        `${deployed.caller.url}/via-binding`,
      ).pipe(Effect.flatMap((res) => res.text));
      expect(viaBinding).toBe("200:pong from target");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
