import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hdinsight from "@distilled.cloud/azure/hdinsight";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* hdinsight.GetCluster({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
    });
  });

// The smallest cluster (2 x E4_v3 head + 1-2 x E4_v3 worker + ZooKeeper)
// needs up to 22 HDInsight cores (~$2-4/hour), 20+ minutes to create and
// 10-20 to delete (~1 hour wall clock, ~$3). Paid subscriptions only.
// Skipped: failed in the last live run. Error: Microsoft.HDInsight/cores quota is still 0 (wanted
// 24) after 10 minutes
test.provider.skip(
  "create, resize, update credentials and tags, and delete a cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureQuota(hdinsightCores);
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(clusterStorage);
      const key = yield* accountKey(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { cluster } = yield* stack.deploy(
        clusterProgram(key, { tags: { env: "test" } }),
      );
      expect(cluster.kind).toEqual("hadoop");
      expect(cluster.url).toEqual(
        `https://${cluster.clusterName}.azurehdinsight.net`,
      );
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.properties?.clusterState).toEqual("Running");
      expect(observed.tags?.env).toEqual("test");
      expect(
        observed.properties?.computeProfile?.roles?.find(
          (r) => r.name === "workernode",
        )?.targetInstanceCount,
      ).toEqual(1);

      // In place: tags, worker count, gateway password.
      const newPassword = Redacted.make("Alchemy-Hdi-Test-Pass2!");
      const updated = yield* stack.deploy(
        clusterProgram(key, {
          tags: { env: "prod" },
          workerNode: { count: 2 },
          gatewayPassword: newPassword,
        }),
      );
      expect(updated.cluster.clusterId).toEqual(cluster.clusterId);
      expect(updated.cluster.workerNodeCount).toEqual(2);
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(
        reobserved.properties?.computeProfile?.roles?.find(
          (r) => r.name === "workernode",
        )?.targetInstanceCount,
      ).toEqual(2);
      const gateway = yield* hdinsight.GetClusterGatewaySettings({
        subscriptionId: yield* subscription,
        resourceGroupName: group.resourceGroupName,
        clusterName: cluster.clusterName,
      });
      const password = gateway.restAuthCredential_password;
      expect(
        password === undefined || typeof password === "string"
          ? password
          : Redacted.value(password),
      ).toEqual(Redacted.value(newPassword));

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCluster(group.resourceGroupName, cluster.clusterName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);

// Ungated probe (storage account only, < $0.01, ~2 minutes): while the
// subscription's HDInsight cores limit in eastus is below a minimal
// cluster's 18 cores (new subscriptions start at 0, and Microsoft.Quota
// answers raises with `QuotaNotAvailableForResource`, so it takes a support
// ticket), creating a cluster is rejected up front with the typed quota
// error and nothing is provisioned. Once the limit covers a cluster the
// lifecycle test above exercises creation instead.
test.provider(
  "a subscription without HDInsight cores rejects cluster creation with a typed quota error",
  (stack) =>
    Effect.gen(function* () {
      const usages = yield* hdinsight.ListLocationUsages({
        subscriptionId: yield* subscription,
        location: "eastus",
      });
      const cores = usages.value?.find((u) => u.name?.value === "cores");
      // Guard: with enough cores the deploy below would provision a real
      // cluster.
      if ((cores?.limit ?? 0) >= 18) return;

      yield* stack.destroy();
      const { group, account } = yield* stack.deploy(clusterStorage);
      const key = yield* accountKey(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const error = yield* stack.deploy(clusterProgram(key)).pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain("HDInsightCoresQuotaExceeded");

      // Nothing was created.
      const listed = yield* hdinsight.ListClusterByResourceGroup({
        subscriptionId: yield* subscription,
        resourceGroupName: group.resourceGroupName,
      });
      expect(listed.value ?? []).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
