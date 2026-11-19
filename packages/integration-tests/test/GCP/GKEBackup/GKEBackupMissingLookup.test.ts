import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:gkebackup", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-backup-channel": GCP.GKEBackup.BackupChannel.lookup({ backupChannelId: name })
          .name,
        "missing-backup-plan": GCP.GKEBackup.BackupPlan.lookup({ backupPlanId: name }).name,
        "missing-backup-plans-backup": GCP.GKEBackup.BackupPlansBackup.lookup({
          backupId: name,
          backupPlan: name,
        }).name,
        "missing-restore-channel": GCP.GKEBackup.RestoreChannel.lookup({ restoreChannelId: name })
          .name,
        "missing-restore-plan": GCP.GKEBackup.RestorePlan.lookup({ restorePlanId: name }).name,
        "missing-restore-plans-restore": GCP.GKEBackup.RestorePlansRestore.lookup({
          restoreId: name,
          restorePlan: name,
        }).name,
      });
    }),
  { tags, timeout: 150000 },
);
