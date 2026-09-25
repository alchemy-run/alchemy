import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as backupdr from "@distilled.cloud/gcp/backupdr_v1";
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

// Backup and DR Service API is disabled on the default testing project
// (`Forbidden`: "Backup and DR Service API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_BACKUPDR=1 on an entitled project to run the full lifecycle.
const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_BACKUPDR === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";

const dailyRule = {
  ruleId: "daily",
  backupRetentionDays: 1,
  standardSchedule: {
    recurrenceType: "DAILY" as const,
    timeZone: "UTC",
    backupWindow: { startHourOfDay: 1, endHourOfDay: 5 },
  },
};

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsBackupPlanAssociations on a missing association fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        backupdr.getProjectsLocationsBackupPlanAssociations({
          name: `projects/${project}/locations/us-central1/backupPlanAssociations/alchemy-backupdr-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* backupdr
        .listProjectsLocationsBackupPlanAssociations({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ backupPlanAssociations: [] as const }),
          ),
        );
      expect(Array.isArray(page.backupPlanAssociations ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create against a missing plan is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Backupdr.BackupPlanAssociation("VmPlan", {
              resource: `projects/${project}/zones/us-central1-a/instances/alchemy-backupdr-missing`,
              resourceType: "compute.googleapis.com/Instance",
              backupPlan: `projects/${project}/locations/us-central1/backupPlans/alchemy-backupdr-missing`,
            });
          }),
        ),
      );
      expect([
        "BadRequest",
        "NotFound",
        "Forbidden",
        "GCP.Backupdr.OperationFailed",
        "GCP.Backupdr.ResourceFailed",
        "GCP.Backupdr.ResourceNotReady",
        "GCP.Backupdr.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create against a missing compute instance is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const vault = yield* GCP.Backupdr.BackupVault("Vault", {
              backupMinimumEnforcedRetentionDuration: "86400s",
              description: "alchemy-test-bpa-vault",
              labels: { env: "test" },
            });
            const plan = yield* GCP.Backupdr.BackupPlan("Nightly", {
              backupVault: vault.name,
              resourceType: "compute.googleapis.com/Instance",
              backupRules: [dailyRule],
              description: "alchemy-test-bpa-plan",
              labels: { env: "test" },
            });
            return yield* GCP.Backupdr.BackupPlanAssociation("VmPlan", {
              resource: `projects/${project}/zones/us-central1-a/instances/alchemy-backupdr-missing`,
              resourceType: "compute.googleapis.com/Instance",
              backupPlan: plan.name,
            });
          }),
        ),
      );
      expect([
        "BadRequest",
        "NotFound",
        "Forbidden",
        "GCP.Backupdr.OperationFailed",
        "GCP.Backupdr.ResourceFailed",
        "GCP.Backupdr.ResourceNotReady",
        "GCP.Backupdr.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
