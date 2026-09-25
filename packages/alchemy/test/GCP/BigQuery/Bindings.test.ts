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
  "Query, InsertAll, and ListTabledata round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const table = yield* GCP.BigQuery.Table("Events", {
            datasetId: dataset.datasetId,
            schema: [{ name: "id", type: "STRING" }],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* table.tableId;
              const query = yield* GCP.BigQuery.Query(dataset);
              const insertAll = yield* GCP.BigQuery.InsertAll(table);
              const listRows = yield* GCP.BigQuery.ListTabledata(table);
              return Effect.fn(function* () {
                const selected = yield* query({ query: "SELECT 1 AS n" });
                const inserted = yield* insertAll({
                  body: { rows: [{ json: { id: "1" } }] },
                });
                const page = yield* listRows({ maxResults: 10 });
                return { selected, inserted, page };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.selected.jobComplete).toEqual(true);
      expect((out.selected.rows ?? []).length).toBeGreaterThan(0);
      expect(out.inserted.insertErrors ?? []).toEqual([]);
      expect(Array.isArray(out.page.rows ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
