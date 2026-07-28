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
 * Under `alchemy dev` the R2 Bucket resource is emulated by the local
 * provider (a `dev:`-prefixed bucket name, no cloud API calls) and the
 * worker's `r2_bucket` binding is lowered onto the local workerd R2
 * simulator. This exercises the full local roundtrip: put / get / head /
 * list / delete through the native `env` binding.
 */
test.provider(
  "R2 bucket binding round-trips against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2.Bucket("LocalBucket");
          const worker = yield* Cloudflare.Worker("r2-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/r2-local-worker.ts",
            ),
            env: { BUCKET: bucket },
          });
          return { bucket, worker };
        }),
      );

      // The local provider fabricates a `dev:` name — proof no cloud call ran.
      expect(deployed.bucket.bucketName).toMatch(/^dev:/);

      const body = (yield* getJsonReady(`${deployed.worker.url}roundtrip`)) as {
        text: string;
        etag: string | null;
        size: number | null;
        keys: string[];
        afterDelete: boolean;
      };
      expect(body.text).toBe("hello r2");
      expect(body.etag).toBeTruthy();
      expect(body.size).toBe("hello r2".length);
      expect(body.keys).toEqual(["greeting.txt"]);
      expect(body.afterDelete).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
