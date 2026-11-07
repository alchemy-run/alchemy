import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:bigtable", "live"];

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
        "missing-app-profile": GCP.Bigtable.AppProfile.lookup({
          appProfileId: short,
          instance: short,
        }).name,
        "missing-cluster": GCP.Bigtable.Cluster.lookup({ clusterId: short, instance: short }).name,
        "missing-instance": GCP.Bigtable.Instance.lookup({ instanceId: short }).name,
        "missing-instances-clusters-backup": GCP.Bigtable.InstancesClustersBackup.lookup({
          backupId: short,
          instance: short,
          cluster: short,
        }).name,
        "missing-instances-logical-view": GCP.Bigtable.InstancesLogicalView.lookup({
          logicalViewId: short,
          instance: short,
        }).name,
        "missing-instances-materialized-view": GCP.Bigtable.InstancesMaterializedView.lookup({
          materializedViewId: short,
          instance: short,
        }).name,
        "missing-instances-tables-authorized-view":
          GCP.Bigtable.InstancesTablesAuthorizedView.lookup({
            authorizedViewId: short,
            instance: short,
            table: short,
          }).name,
        "missing-instances-tables-schema-bundle": GCP.Bigtable.InstancesTablesSchemaBundle.lookup({
          schemaBundleId: short,
          instance: short,
          table: short,
        }).name,
        "missing-table": GCP.Bigtable.Table.lookup({ tableId: short, instance: short }).name,
      });
    }),
  { tags, timeout: 195000 },
);
