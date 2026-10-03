import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hdinsight from "@distilled.cloud/azure/hdinsight";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import {
  accountKey,
  clusterProgram,
  clusterStorage,
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

// The smallest cluster (2 x E4_v3 head + 1 x E4_v3 worker + ZooKeeper) needs
// 12+ HDInsight cores (~$2-4/hour) and 20+ minutes to create and 10-20 to
// delete. The free trial's HDInsight cores quota is 0, so this only runs
// with AZURE_TEST_PAID=1 on a paid subscription (expect ~1 hour wall clock;
// raise the timeout there).
test.provider.skipIf(!runPaidOnly)(
  "create, resize, update credentials and tags, and delete a cluster",
  (stack) =>
    Effect.gen(function* () {
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
  { tags, timeout: 900_000 },
);

// Ungated probe (storage account only, < $0.01, ~2 minutes): the free trial
// has 0 HDInsight cores, so creating a cluster is rejected up front with
// the typed quota error and nothing is provisioned.
test.provider(
  "the free trial rejects cluster creation with a typed quota error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(clusterStorage);
      const key = yield* accountKey(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const usages = yield* hdinsight.ListLocationUsages({
        subscriptionId: yield* subscription,
        location: "eastus",
      });
      const cores = usages.value?.find((u) => u.name?.value === "cores");
      // Also a guard: on a subscription with cores the deploy below would
      // provision a real cluster.
      expect(cores?.limit).toEqual(0);

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
