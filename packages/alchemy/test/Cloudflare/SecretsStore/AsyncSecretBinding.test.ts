import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import Stack from "./fixtures/stack.ts";
import { SECRET_VALUE } from "./fixtures/secret.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Fresh `workers.dev` URLs take a few seconds to start serving 200s, so
// the first request rides this retry schedule.
class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const fetchWhenReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res: HttpClientResponse) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady =>
          e instanceof WorkerNotReady && (e.status === 404 || e.status >= 500),
        schedule: Schedule.exponential("500 millis").pipe(
          Schedule.both(Schedule.recurs(20)),
        ),
      }),
    );
  });

test(
  "SecretsStore Secret declared on a Worker's env round-trips to runtime as a SecretsStoreSecret",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");

    const res = yield* fetchWhenReady(`${url}/secret`);
    expect(res.status).toBe(200);

    const body = (yield* res.json) as { value: string };
    expect(body.value).toBe(SECRET_VALUE);
  }).pipe(logLevel),
  { timeout: 180_000 },
);
