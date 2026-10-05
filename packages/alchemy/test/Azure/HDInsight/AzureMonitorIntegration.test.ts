import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hdinsight from "@distilled.cloud/azure/hdinsight";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import { ensureQuota } from "../quota.ts";
import {
  accountKey,
  clusterProgram,
  clusterStorage,
  hdinsightCores,
  logLevel,
  subscription,
  tags,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getStatus = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* hdinsight.GetExtensionAzureMonitorStatus({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
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
    const monitor = yield* Azure.HDInsight.AzureMonitorIntegration("Monitor", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      workspaceId: workspace.customerId,
      primaryKey: workspace.primarySharedKey.as<Redacted.Redacted<string>>(),
    });
    return { group, cluster, workspace, monitor };
  });

// Needs a running cluster (12+ HDInsight cores, ~$2-4/hour, 20+ minutes)
// and reconfigures every node on each change (5-15 minutes).
// Paid subscriptions only (AZURE_TEST_PAID=1); ~1 hour wall clock, ~$3-4.
// Skipped: failed in the last live run. HDInsightCoresQuotaExceeded: User SubscriptionId
// 'c70ebb38-f39c-4b72-a06c-022451dbbcce' does not have cores left to create resource
// 'azure-hdinsight-azureazolx7chdtnqlxd7vwuui434'. Required: 12, Available: 0.
test.provider.skip(
  "enable, retarget, and disable the Azure Monitor integration",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureQuota(hdinsightCores);
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(clusterStorage);
      const key = yield* accountKey(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { cluster, workspace, monitor } = yield* stack.deploy(
        program(key, "First"),
      );
      expect(monitor.enabled).toEqual(true);
      const observed = yield* getStatus(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.clusterMonitoringEnabled).toEqual(true);
      expect(observed.workspaceId).toEqual(workspace.customerId);

      // In place: point the integration at the second workspace.
      const updated = yield* stack.deploy(program(key, "Second"));
      expect(updated.monitor.workspaceId).toEqual(updated.workspace.customerId);
      expect(
        (yield* getStatus(group.resourceGroupName, cluster.clusterName))
          .workspaceId,
      ).toEqual(updated.workspace.customerId);

      // Remove only the integration; the cluster stays.
      yield* stack.deploy(clusterProgram(key));
      const disabled = yield* getStatus(
        group.resourceGroupName,
        cluster.clusterName,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 seconds"),
          until: (status) => status.clusterMonitoringEnabled !== true,
          times: 30,
        }),
      );
      expect(disabled.clusterMonitoringEnabled).not.toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);

// Ungated probe (resource group only, free): reading the integration of a
// missing cluster fails with the typed not-found the provider maps to
// "absent".
test.provider(
  "the integration of a missing cluster reads as a typed not-found",
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
      const error = yield* getStatus(
        group.resourceGroupName,
        "alchemy-missing-cluster",
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
