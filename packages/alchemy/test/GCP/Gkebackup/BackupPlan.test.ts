import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkebackup from "@distilled.cloud/gcp/gkebackup_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsBackupPlans on a missing plan fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkebackup.getProjectsLocationsBackupPlans({
          name: `projects/${project}/locations/us-central1/backupPlans/alchemy-missing-plan`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* gkebackup
        .listProjectsLocationsBackupPlans({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ backupPlans: [] as const }),
          ),
        );
      expect(Array.isArray(page.backupPlans ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create against a missing cluster is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Gkebackup.BackupPlan("Nightly", {
              cluster: `projects/${project}/locations/us-central1/clusters/alchemy-gkebackup-missing`,
              backupConfig: { allNamespaces: true },
              description: "alchemy-test-plan",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect([
        "BadRequest",
        "NotFound",
        "Forbidden",
        "GCP.Gkebackup.OperationFailed",
        "GCP.Gkebackup.ResourceFailed",
        "GCP.Gkebackup.ResourceNotReady",
        "GCP.Gkebackup.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
