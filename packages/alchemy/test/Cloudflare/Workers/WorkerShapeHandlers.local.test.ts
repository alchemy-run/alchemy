import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ShapeScheduledWorker from "./fixtures/shape-handlers/worker.ts";

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

/**
 * Under `alchemy dev` the Worker's cron triggers expose Miniflare's manual
 * trigger route (`/cdn-cgi/handler/scheduled?cron=...&time=...`). Driving
 * that route exercises the same `scheduled()` dispatch as a live cron fire,
 * without waiting for a minute boundary — and without `CronEventSource`.
 */
test.provider(
  "local worker fires the shape-level scheduled() via the manual trigger route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* ShapeScheduledWorker;
          return { worker };
        }),
      );

      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.worker.crons).toContain("* * * * *");

      const url = deployed.worker.url;
      const client = yield* HttpClient.HttpClient;

      yield* Effect.gen(function* () {
        const res = yield* client.post(`${url}/reset`);
        if (res.status !== 200) {
          return yield* Effect.fail(new WorkerNotReady({ status: res.status }));
        }
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );

      const scheduledTime = Date.now();
      const trigger = yield* client.post(
        `${url}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}&time=${scheduledTime}`,
      );
      expect(trigger.status).toBe(200);
      expect(yield* trigger.text).toBe("ok");

      const times = yield* Effect.gen(function* () {
        const res = yield* client.get(`${url}/times`);
        if (res.status !== 200) return [];
        const body = (yield* res.json) as { times?: unknown };
        return Array.isArray(body.times) ? body.times : [];
      }).pipe(
        Effect.catch(() => Effect.succeed([] as unknown[])),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (times): boolean => times.length > 0,
          times: 10,
        }),
      );

      expect(times).toContain(scheduledTime);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
