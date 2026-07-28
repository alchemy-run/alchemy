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

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.exponential("500 millis"),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * The local runtime ships an always-on Cache API simulator
 * (`caches.default` persisted under `.alchemy/local/cache`) and builds
 * `request.cf` from a fallback blob in the entry middleware. Neither needs
 * any alchemy-side wiring — this pins that both actually work for a worker
 * deployed by the local provider.
 */
test.provider(
  "Cache API and request.cf work under the local runtime",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("cache-cf-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/cache-cf/worker.ts",
            ),
          });
          return { worker };
        }),
      );
      const url = deployed.worker.url!;

      // request.cf: the middleware injects Miniflare's static fallback blob,
      // so `colo`/`country` are present without any configuration.
      const cf = (yield* getJsonReady(`${url}cf`)) as {
        colo: string | null;
        country: string | null;
        clientAcceptEncoding: string | null;
      };
      expect(cf.colo).toBeTruthy();
      expect(cf.country).toBeTruthy();

      // Cache API: first request misses and populates, second hits.
      const first = (yield* getJsonReady(`${url}cache`)) as {
        hit: boolean;
        body: string;
      };
      expect(first.hit).toBe(false);
      expect(first.body).toBe("cached-body");

      const second = (yield* getJsonReady(`${url}cache`)) as {
        hit: boolean;
        body: string;
      };
      expect(second.hit).toBe(true);
      expect(second.body).toBe("cached-body");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
