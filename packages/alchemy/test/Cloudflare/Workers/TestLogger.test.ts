import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { Constants } from "@/Cloudflare/Workers/TestLoggerConstants.ts";
import {
  hasTestLoggerBinding,
  testLoggerTail,
} from "@/Cloudflare/Workers/TestLoggerWorker.ts";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import LogTestWorker from "./fixtures/test-logger/worker.ts";

// `log: true` is the surface under test: the Worker provider must patch the
// fixture's console, ensure the account-level logger singleton, and attach
// the DO binding — and `testLoggerTail` must stream the resulting rows.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  log: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "console logs stream through the test logger DO",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LogTestWorker;
        }),
      );
      expect(worker.testLogger).toBe(true);
      expect(worker.url).toBeDefined();

      // Out-of-band: the account-level logger singleton was ensured...
      const logger = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: Constants.TEST_LOGGER_WORKER_NAME,
      });
      expect(
        (logger.bindings ?? []).some(
          (b) =>
            b.type === "durable_object_namespace" &&
            "className" in b &&
            b.className === Constants.TEST_LOGGER_CLASS_NAME,
        ),
      ).toBe(true);

      // ...and the fixture worker carries the test-logger DO binding.
      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: worker.workerName,
      });
      expect(hasTestLoggerBinding(settings.bindings)).toBe(true);

      const client = yield* HttpClient.HttpClient;
      const tailOptions = {
        accountId,
        workerName: worker.workerName,
        stack: { name: stack.name, stage: "test" },
      };

      // Replay path: log BEFORE any tail is connected — the DO buffers the
      // row and replays it when the websocket connects. The first request
      // doubles as the workers.dev readiness probe.
      yield* Effect.gen(function* () {
        const res = yield* client.get(`${worker.url}/log?msg=replay-probe`);
        if (res.status !== 200) {
          return yield* Effect.fail(
            new Error(`Worker not ready: ${res.status}`),
          );
        }
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );

      const replayed = yield* testLoggerTail(tailOptions).pipe(
        Stream.filter((line) => line.message.includes("replay-probe")),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("30 seconds"),
      );
      expect(Array.from(replayed)).toHaveLength(1);

      // Live path: connect a tail first, then log — the DO pushes the row
      // to the open websocket. Both run concurrently; the collector wins as
      // soon as the row arrives.
      const [live] = yield* Effect.all(
        [
          testLoggerTail(tailOptions).pipe(
            Stream.filter((line) => line.message.includes("live-probe")),
            Stream.take(1),
            Stream.runCollect,
          ),
          Effect.sleep("3 seconds").pipe(
            Effect.andThen(client.get(`${worker.url}/log?msg=live-probe`)),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("60 seconds"));
      const liveLines = Array.from(live);
      expect(liveLines).toHaveLength(1);
      expect(liveLines[0]!.message).toBe("live-probe");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
