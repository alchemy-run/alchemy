import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* eventhub.GetCluster({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
    });
  });

const program = (clusterTags: Record<string, string>) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cluster = yield* Azure.EventHub.Cluster("Dedicated", {
      resourceGroup: group.resourceGroupName,
      capacity: 1,
      supportsScaling: true,
      tags: clusterTags,
    });
    return { group, cluster };
  });

// Dedicated clusters bill ~$6.85 per CU-hour with a 4-hour minimum (a
// cluster cannot be deleted for 4 hours after creation), so one run costs
// ~$27+ and provisioning can take over an hour. Not available on the free
// trial; run only on a paid subscription with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a dedicated event hubs cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(
        program({ env: "test" }),
      );
      expect(cluster.capacity).toEqual(1);
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.sku?.name).toEqual("Dedicated");
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ env: "prod" }));
      expect(updated.cluster.clusterId).toEqual(cluster.clusterId);
      expect(
        (yield* getCluster(group.resourceGroupName, cluster.clusterName)).tags
          ?.env,
      ).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCluster(group.resourceGroupName, cluster.clusterName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
