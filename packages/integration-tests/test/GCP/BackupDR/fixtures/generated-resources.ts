import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** BackupDR resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeBackupVault = GCP.BackupDR.BackupVault("ProbeBackupVault", {
  backupMinimumEnforcedRetentionDuration: "86400s",
  description: "alchemy-test-vault",
});

export const ProbeBackupPlan = Effect.gen(function* () {
  const vault = yield* ProbeBackupVault;
  return yield* GCP.BackupDR.BackupPlan("ProbeBackupPlan", {
    backupVault: vault.name,
    resourceType: "compute.googleapis.com/Instance",
    backupRules: [
      {
        ruleId: "daily",
        backupRetentionDays: 1,
        standardSchedule: {
          recurrenceType: "DAILY",
          timeZone: "UTC",
          backupWindow: { startHourOfDay: 1, endHourOfDay: 5 },
        },
      },
    ],
  });
});
