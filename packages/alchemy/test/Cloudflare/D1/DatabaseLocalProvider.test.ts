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
 * Under `alchemy dev` the D1 Database resource is emulated by the local
 * provider (a `dev:` id, no cloud API calls) and the worker's `d1` binding
 * is lowered onto the local workerd D1 simulator (workerd's real
 * `cloudflare-internal:d1-api` over DO SQLite). This exercises DDL,
 * prepared statements, and reads through the native `env` binding.
 */
test.provider(
  "D1 database binding round-trips against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const db = yield* Cloudflare.D1.Database("LocalDB");
          const worker = yield* Cloudflare.Worker("d1-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/d1-local-worker.ts",
            ),
            env: { DB: db },
          });
          return { db, worker };
        }),
      );

      // The local provider fabricates a `dev:` id — proof no cloud call ran.
      expect(deployed.db.databaseId).toMatch(/^dev:/);

      const body = (yield* getJsonReady(`${deployed.worker.url}roundtrip`)) as {
        names: string[];
        count: number | null;
      };
      expect(body.names).toEqual(["alice", "bob"]);
      expect(body.count).toBe(2);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
