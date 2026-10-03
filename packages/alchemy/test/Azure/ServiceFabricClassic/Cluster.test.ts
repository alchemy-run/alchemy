import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicefabric from "@distilled.cloud/azure/servicefabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  subscription,
  tags,
  testCertificate,
  testNodeTypes,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* servicefabric.GetCluster({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
    });
  });

const program = (props: {
  tags: Record<string, string>;
  name?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cluster = yield* Azure.ServiceFabricClassic.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      reliabilityLevel: "None",
      vmImage: "Windows",
      certificate: testCertificate,
      nodeTypes: testNodeTypes(),
      tags: props.tags,
    });
    return { group, cluster };
  });

// The cluster resource alone is free: without node scale sets it stays in
// `WaitingForNodes`, so no VM is billed. Provisioning takes ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a classic service fabric cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(cluster.clusterName.length).toBeLessThanOrEqual(23);
      expect(cluster.clusterState).toEqual("WaitingForNodes");
      expect(cluster.managementEndpoint).toMatch(/^https:.*:19080$/);
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.properties?.reliabilityLevel).toEqual("None");
      expect(observed.properties?.nodeTypes[0]?.name).toEqual("nt1");
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags (PATCH). Property PATCHes (add-ons, reliability) are
      // accepted but only applied once nodes join, so a cluster without
      // scale sets cannot verify them.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.cluster.clusterResourceId).toEqual(
        cluster.clusterResourceId,
      );
      expect(
        (yield* getCluster(group.resourceGroupName, cluster.clusterName)).tags
          ?.env,
      ).toEqual("prod");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          tags: { env: "prod" },
          name: `${cluster.clusterName.slice(0, 18)}-rep`,
        }),
      );
      expect(replaced.cluster.clusterName).not.toEqual(cluster.clusterName);
      expect(
        yield* waitGone(getCluster(group.resourceGroupName, cluster.clusterName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCluster(group.resourceGroupName, replaced.cluster.clusterName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
