import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const NAME = "alchemy-imquery-probe";

// Temporary diagnostic probe: exercise the query interface directly via
// distilled to observe the exact typed error the Lambda fixture dies on.
test.provider(
  "probe: startQuery on an empty monitor",
  () =>
    Effect.gen(function* () {
      yield* im
        .createMonitor({
          MonitorName: NAME,
          Resources: [],
          MaxCityNetworksToMonitor: 1,
        })
        .pipe(Effect.catchTag("ConflictException", () => Effect.void));

      // wait until ACTIVE
      yield* im.getMonitor({ MonitorName: NAME }).pipe(
        Effect.flatMap((m) =>
          m.Status === "ACTIVE"
            ? Effect.void
            : Effect.fail(new Error(`status ${m.Status}`)),
        ),
        Effect.retry({
          while: (e) => e instanceof Error,
          schedule: Schedule.max([
            Schedule.fixed("5 seconds"),
            Schedule.recurs(10),
          ]),
        }),
      );

      const now = yield* Effect.sync(() => Date.now());
      const start = yield* Effect.result(
        im.startQuery({
          MonitorName: NAME,
          StartTime: new Date(now - 3_600_000),
          EndTime: new Date(now),
          QueryType: "MEASUREMENTS",
        }),
      );
      if (Result.isSuccess(start)) {
        console.log("startQuery OK:", JSON.stringify(start.value));
        const QueryId = start.value.QueryId;
        const status = yield* Effect.result(
          im.getQueryStatus({ MonitorName: NAME, QueryId }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean =>
                r.Status !== "QUEUED" && r.Status !== "RUNNING",
              times: 20,
            }),
          ),
        );
        console.log(
          "getQueryStatus:",
          Result.isSuccess(status)
            ? JSON.stringify(status.value)
            : `ERROR ${JSON.stringify(status.failure)}`,
        );
        if (Result.isSuccess(status) && status.value.Status === "SUCCEEDED") {
          const results = yield* Effect.result(
            im.getQueryResults({ MonitorName: NAME, QueryId }),
          );
          console.log(
            "getQueryResults:",
            Result.isSuccess(results)
              ? `fields=${results.value.Fields.length} rows=${results.value.Data.length}`
              : `ERROR ${JSON.stringify(results.failure)}`,
          );
        }
        const stop = yield* Effect.result(
          im.stopQuery({ MonitorName: NAME, QueryId }),
        );
        console.log(
          "stopQuery:",
          Result.isSuccess(stop)
            ? "ok"
            : `ERROR ${JSON.stringify(stop.failure)}`,
        );
      } else {
        console.log("startQuery ERROR:", JSON.stringify(start.failure));
      }

      // cleanup: deactivate, delete, reap log groups
      yield* im
        .updateMonitor({ MonitorName: NAME, Status: "INACTIVE" })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
      yield* im.getMonitor({ MonitorName: NAME }).pipe(
        Effect.flatMap((m) =>
          m.Status === "INACTIVE"
            ? Effect.void
            : Effect.fail(new Error(`status ${m.Status}`)),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          while: (e) => e instanceof Error,
          schedule: Schedule.max([
            Schedule.fixed("5 seconds"),
            Schedule.recurs(10),
          ]),
        }),
      );
      yield* im
        .deleteMonitor({ MonitorName: NAME })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
      const groups = yield* logs
        .describeLogGroups({
          logGroupNamePrefix: `/aws/internet-monitor/${NAME}`,
        })
        .pipe(Effect.map((r) => r.logGroups ?? []));
      yield* Effect.forEach(
        groups.flatMap((g) =>
          g.logGroupName !== undefined ? [g.logGroupName] : [],
        ),
        (logGroupName) =>
          logs
            .deleteLogGroup({ logGroupName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
      );
    }),
  { timeout: 240_000 },
);
