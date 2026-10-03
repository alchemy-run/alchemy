import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hdinsight from "@distilled.cloud/azure/hdinsight";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import {
  accountKey,
  clusterProgram,
  clusterStorage,
  logLevel,
  subscription,
  tags,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getExtension = (
  resourceGroupName: string,
  clusterName: string,
  extensionName: string,
) =>
  Effect.gen(function* () {
    return yield* hdinsight.GetExtension({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      extensionName,
    });
  });

const program = (
  key: Redacted.Redacted<string>,
  workspaceId: "First" | "Second",
) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* clusterProgram(key);
    // Both workspaces stay deployed across the update step.
    const first = yield* Azure.LogAnalytics.Workspace("First", {
      resourceGroup: group.resourceGroupName,
    });
    const second = yield* Azure.LogAnalytics.Workspace("Second", {
      resourceGroup: group.resourceGroupName,
    });
    const workspace = workspaceId === "First" ? first : second;
    const extension = yield* Azure.HDInsight.Extension("Monitoring", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      extensionName: "clustermonitoring",
      workspaceId: workspace.customerId,
      primaryKey: workspace.primarySharedKey.as<Redacted.Redacted<string>>(),
    });
    return { group, cluster, workspace, extension };
  });

// Needs a running cluster (12+ HDInsight cores, ~$2-4/hour, 20+ minutes)
// and reconfigures every node on each change (5-15 minutes). The free
// trial's HDInsight cores quota is 0 (see the quota probe in
// Cluster.test.ts), so this only runs with AZURE_TEST_PAID=1 (expect ~1
// hour wall clock; raise the timeout there).
test.provider.skipIf(!runPaidOnly)(
  "enable, retarget, and disable the clustermonitoring extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(clusterStorage);
      const key = yield* accountKey(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { cluster, workspace, extension } = yield* stack.deploy(
        program(key, "First"),
      );
      expect(extension.enabled).toEqual(true);
      const get = () =>
        getExtension(
          group.resourceGroupName,
          cluster.clusterName,
          "clustermonitoring",
        );
      const observed = yield* get();
      expect(observed.clusterMonitoringEnabled).toEqual(true);
      expect(observed.workspaceId).toEqual(workspace.customerId);

      // In place: point the extension at the second workspace.
      const updated = yield* stack.deploy(program(key, "Second"));
      expect((yield* get()).workspaceId).toEqual(updated.workspace.customerId);

      // Remove only the extension; the cluster stays.
      yield* stack.deploy(clusterProgram(key));
      const disabled = yield* get().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 seconds"),
          until: (status) => status.clusterMonitoringEnabled !== true,
          times: 30,
        }),
      );
      expect(disabled.clusterMonitoringEnabled).not.toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (resource group only, free): reading an extension of a
// missing cluster fails with the typed not-found the provider maps to
// "absent".
test.provider(
  "an extension of a missing cluster reads as a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* getExtension(
        group.resourceGroupName,
        "alchemy-missing-cluster",
        "clustermonitoring",
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
