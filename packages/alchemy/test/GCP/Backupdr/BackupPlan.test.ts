import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as backupdr from "@distilled.cloud/gcp/backupdr_v1";
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

const waitUntilGone = (name: string) =>
  backupdr.getProjectsLocationsBackupPlans({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsBackupPlans on a missing plan fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        backupdr.getProjectsLocationsBackupPlans({
          name: `projects/${project}/locations/us-central1/backupPlans/alchemy-backupdr-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* backupdr
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
  "create against a missing vault is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Backupdr.BackupPlan("Nightly", {
              backupVault: `projects/${project}/locations/us-central1/backupVaults/alchemy-backupdr-missing`,
              resourceType: "compute.googleapis.com/Instance",
              backupRules: [dailyRule],
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
  "create, update, and delete a backup plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vault = yield* GCP.Backupdr.BackupVault("Vault", {
            backupMinimumEnforcedRetentionDuration: "86400s",
            description: "alchemy-test-plan-vault",
            labels: { env: "test" },
          });
          return yield* GCP.Backupdr.BackupPlan("Nightly", {
            backupVault: vault.name,
            resourceType: "compute.googleapis.com/Instance",
            backupRules: [dailyRule],
            description: "alchemy-test-plan",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/backupPlans/");
      expect(created.backupPlanId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.resourceType).toEqual("compute.googleapis.com/Instance");
      expect(created.description).toEqual("alchemy-test-plan");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* backupdr.getProjectsLocationsBackupPlans({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("alchemy-test-plan");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const vault = yield* GCP.Backupdr.BackupVault("Vault", {
            backupVaultId: created.backupVault
              ? created.backupVault.split("/").pop()
              : undefined,
            backupMinimumEnforcedRetentionDuration: "86400s",
            description: "alchemy-test-plan-vault",
            labels: { env: "test" },
          });
          return yield* GCP.Backupdr.BackupPlan("Nightly", {
            backupPlanId: created.backupPlanId,
            backupVault: vault.name,
            resourceType: "compute.googleapis.com/Instance",
            backupRules: [dailyRule],
            description: "alchemy-prod-plan",
            labels: { env: "prod", role: "backup" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-plan");
      expect(updated.labels).toMatchObject({ env: "prod", role: "backup" });

      const refetched = yield* backupdr.getProjectsLocationsBackupPlans({
        name: created.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-plan");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("backup");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
