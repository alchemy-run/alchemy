import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:spanner", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const short = name.slice(0, 30).replace(/-+$/, "");
      yield* expectAllMissing(stack, {
        "missing-database": GCP.Spanner.Database.lookup({ databaseId: short, instance: short })
          .name,
        "missing-instance": GCP.Spanner.Instance.lookup({ instanceId: short }).name,
        "missing-instance-config": GCP.Spanner.InstanceConfig.lookup({ instanceConfigId: short })
          .name,
        "missing-instances-backup": GCP.Spanner.InstancesBackup.lookup({
          backupId: short,
          instance: short,
        }).name,
        "missing-instances-databases-backup-schedule":
          GCP.Spanner.InstancesDatabasesBackupSchedule.lookup({
            backupScheduleId: short,
            instance: short,
            database: short,
          }).name,
        "missing-instances-instance-partition": GCP.Spanner.InstancesInstancePartition.lookup({
          instancePartitionId: short,
          instance: short,
        }).name,
      });
    }),
  { tags, timeout: 150000 },
);
