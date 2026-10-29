import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import Stack from "./fixtures/cron/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test.provider(
  "registers the event source's schedule with Cloudflare",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { workerName, crons } = yield* stack;
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { schedules } = yield* workers.getScriptSchedule({ accountId, scriptName: workerName });
      expect(crons).toEqual(["* * * * *"]);
      expect(schedules.map(({ cron }) => cron)).toEqual(crons);
      yield* scratch.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
);

test.provider(
  "registers the crons prop of a worker that returns scheduled from its shape",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { shapeWorkerName, shapeCrons } = yield* stack;
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { schedules } = yield* workers.getScriptSchedule({
        accountId,
        scriptName: shapeWorkerName,
      });
      expect(shapeCrons).toEqual(["* * * * *"]);
      expect(schedules.map(({ cron }) => cron)).toEqual(shapeCrons);
      yield* scratch.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
);

test(
  "a shape-level scheduled handler is not an RPC method",
  Effect.gen(function* () {
    const { shapeUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const body = yield* Effect.gen(function* () {
      const res = yield* client.get(`${shapeUrl}/rpc`);
      if (res.status !== 200) {
        return yield* Effect.fail(new WorkerNotReady({ status: res.status }));
      }
      return yield* res.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ greeting: Schema.String, scheduled: Schema.String }),
          ),
        ),
      );
    }).pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }));
    expect(body).toEqual({ greeting: "hello cron", scheduled: "undefined" });
  }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 60_000 },
);

// Resets the worker's counter DO, then polls `GET /times` until a cron fire
// newer than the reset is recorded.
const waitForCronFire = Effect.fn(function* (url: string) {
  const client = yield* HttpClient.HttpClient;

  // Reset also probes readiness of a fresh workers.dev URL.
  yield* Effect.gen(function* () {
    const res = yield* client.post(`${url}/reset`);
    if (res.status !== 200) {
      return yield* Effect.fail(new WorkerNotReady({ status: res.status }));
    }
  }).pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }));
  const resetAt = yield* Effect.sync(() => Date.now());

  const times = yield* Effect.gen(function* () {
    const res = yield* client.get(`${url}/times`);
    expect(res.status).toBe(200);
    const body = yield* res.json.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Struct({ times: Schema.Array(Schema.Number) })),
      ),
    );
    return body.times.filter((time) => time >= resetAt);
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (recent) => recent.length > 0,
      times: 9,
    }),
  );

  expect(times.length).toBeGreaterThan(0);
  for (const time of times) {
    expect(time).toBeGreaterThanOrEqual(resetAt);
  }
});

// New schedules can take up to 15 minutes to propagate. Retain the fixture
// with NO_DESTROY=1 before opting into wall-clock delivery. The local suite
// covers native scheduled dispatch without waiting for cloud propagation.
test.skipIf(!!process.env.FAST || process.env.CLOUDFLARE_TEST_CRON_DELIVERY !== "1")(
  "deployed worker fires the scheduled handler on its cron trigger",
  Effect.gen(function* () {
    const { url, crons } = yield* stack;
    expect(crons).toContain("* * * * *");
    yield* waitForCronFire(url);
  }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 120_000 },
);

test.skipIf(!!process.env.FAST || process.env.CLOUDFLARE_TEST_CRON_DELIVERY !== "1")(
  "deployed worker fires the shape-level scheduled handler on its cron trigger",
  Effect.gen(function* () {
    const { shapeUrl, shapeCrons } = yield* stack;
    expect(shapeCrons).toContain("* * * * *");
    yield* waitForCronFire(shapeUrl);
  }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 120_000 },
);
