import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";

const waitUntilGone = (name: string) =>
  scc.getProjectsBigQueryExports({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsBigQueryExports on a missing export fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        scc.getProjectsBigQueryExports({
          name: `projects/${project}/bigQueryExports/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a BigQuery export",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* scc
        .listProjectsBigQueryExports({
          parent: `projects/${project}`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("SccExport", {
            location: "US",
            forceDestroy: true,
          });
          const exp = yield* GCP.Securitycenter.BigQueryExport("High", {
            dataset: dataset.name,
            description: "high severity",
            filter: 'severity="HIGH"',
          });
          return { dataset, exp };
        }),
      );

      expect(created.exp.exportId).toEqual(expect.any(String));
      expect(created.exp.name).toEqual(
        `projects/${project}/bigQueryExports/${created.exp.exportId}`,
      );
      expect(created.exp.dataset).toEqual(created.dataset.name);
      expect(created.exp.description).toEqual("high severity");
      expect(created.exp.filter).toEqual('severity="HIGH"');

      const fetched = yield* scc.getProjectsBigQueryExports({
        name: created.exp.name,
      });
      expect(fetched.name).toEqual(created.exp.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.dataset).toEqual(created.dataset.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("SccExport", {
            datasetId: created.dataset.datasetId,
            location: "US",
            forceDestroy: true,
          });
          const exp = yield* GCP.Securitycenter.BigQueryExport("High", {
            exportId: created.exp.exportId,
            dataset: dataset.name,
            description: "high and critical",
            filter: 'severity="HIGH" OR severity="CRITICAL"',
          });
          return { dataset, exp };
        }),
      );

      expect(updated.exp.name).toEqual(created.exp.name);
      expect(updated.exp.description).toEqual("high and critical");
      expect(updated.exp.filter).toEqual(
        'severity="HIGH" OR severity="CRITICAL"',
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.exp.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
