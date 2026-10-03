import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, testCluster, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const location = "southcentralus";

const getSnapshot = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetSnapshot({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });

const program = (snapshotTags: Record<string, string>) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* testCluster(location);
    const snapshot = yield* Azure.ContainerService.Snapshot("Snapshot", {
      resourceGroup: group.resourceGroupName,
      location,
      // The cluster's system pool (named "system" by default).
      sourceAgentPoolId: Output.interpolate`${cluster.clusterId}/agentPools/system`,
      tags: snapshotTags,
    });
    return { group, cluster, snapshot };
  });

// Test cluster (~6 min create, ~5 min delete, ~$0.03) plus a node pool
// snapshot (~1-2 min, negligible storage cost).
test.provider(
  "create, update, and delete a node pool snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ env: "test" }));
      const { group, snapshot } = created;
      expect(snapshot.vmSize).toEqual("Standard_D2s_v7");
      expect(snapshot.nodeImageVersion).toBeTruthy();
      expect(snapshot.sourceAgentPoolId.toLowerCase()).toContain(
        "/agentpools/system",
      );
      const observed = yield* getSnapshot(
        group.resourceGroupName,
        snapshot.snapshotName,
      );
      expect(observed.properties?.snapshotType).toEqual("NodePool");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Snapshot");

      const updated = yield* stack.deploy(program({ env: "prod" }));
      expect(updated.snapshot.snapshotId).toEqual(snapshot.snapshotId);
      expect(updated.snapshot.tags).toEqual({ env: "prod" });
      const reobserved = yield* getSnapshot(
        group.resourceGroupName,
        snapshot.snapshotName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getSnapshot(group.resourceGroupName, snapshot.snapshotName),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), withVcpus(2), logLevel),
  { tags: [...tags], timeout: 900_000 },
);
