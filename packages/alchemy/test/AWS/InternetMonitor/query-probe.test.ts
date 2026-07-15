// TEMPORARY probe — observes the full query-interface loop on an empty monitor.
import * as AWS from "@/AWS";
import { Monitor } from "@/AWS/InternetMonitor";
import * as Test from "@/Test/Vitest";
import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "probe: full query loop on an empty monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const m = yield* Monitor("QueryProbeMonitor", {
            resources: [],
            maxCityNetworksToMonitor: 1,
          });
          return { name: m.monitorName };
        }),
      );
      const { QueryId } = yield* im.startQuery({
        MonitorName: out.name,
        StartTime: new Date(Date.now() - 3_600_000),
        EndTime: new Date(),
        QueryType: "MEASUREMENTS",
      });
      yield* Effect.logInfo(`QueryId: ${QueryId.slice(0, 40)}...`);

      const status = yield* Effect.result(
        im.getQueryStatus({ MonitorName: out.name, QueryId }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (r): boolean =>
              r.Status !== "QUEUED" && r.Status !== "RUNNING",
            times: 20,
          }),
        ),
      );
      yield* Effect.logInfo(`status result: ${JSON.stringify(status)}`);

      const results = yield* Effect.result(
        im.getQueryResults({ MonitorName: out.name, QueryId }),
      );
      yield* Effect.logInfo(
        `results result: ${
          Result.isSuccess(results)
            ? JSON.stringify(results.success)
            : `FAIL ${String(results.failure)}`
        }`,
      );

      const stop = yield* Effect.result(
        im.stopQuery({ MonitorName: out.name, QueryId }),
      );
      yield* Effect.logInfo(
        `stop result: ${
          Result.isSuccess(stop) ? "ok" : `FAIL ${String(stop.failure)}`
        }`,
      );

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
