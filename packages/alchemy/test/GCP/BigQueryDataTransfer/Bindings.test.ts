import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

test.provider.skipIf(!hasGcpCreds)(
  "StartManualRuns invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const config = yield* GCP.BigQueryDataTransfer.TransferConfig(
            "Copy",
            {
              location: "us-central1",
              dataSourceId: "scheduled_query",
              destinationDatasetId: dataset.datasetId,
              scheduleOptions: { disableAutoScheduling: true },
              params: {
                query: "SELECT 1 AS n",
                destination_table_name_template: "nightly",
                write_disposition: "WRITE_TRUNCATE",
              },
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* config.name;
              const start =
                yield* GCP.BigQueryDataTransfer.StartManualRuns(config);
              return Effect.fn(function* () {
                return yield* start({
                  body: { requestedRunTime: "2020-01-01T00:00:00Z" },
                });
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(Array.isArray(out.runs ?? [])).toEqual(true);
      expect(out.runs?.[0]?.name).toContain("/runs/");
      expect(out.runs?.[0]?.dataSourceId).toEqual("scheduled_query");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
