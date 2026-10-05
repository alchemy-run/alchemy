import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sf from "@distilled.cloud/azure/servicefabricmanagedclusters";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly, withPublicIps, withVcpus } from "../gates.ts";
import {
  clusterAuth,
  logLevel,
  nodeLocation,
  nodeVmSize,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNodeType = (
  resourceGroupName: string,
  clusterName: string,
  nodeTypeName: string,
) =>
  Effect.gen(function* () {
    return yield* sf.GetNodeType({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      nodeTypeName,
    });
  });

const program = (props: {
  tags: Record<string, string>;
  placementProperties?: Record<string, string>;
  vmSize?: string;
  location?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: props.location ?? nodeLocation,
    });
    const cluster = yield* Azure.ServiceFabric.ManagedCluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      ...clusterAuth,
    });
    const nodeType = yield* Azure.ServiceFabric.NodeType("Primary", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.managedClusterName,
      isPrimary: true,
      vmInstanceCount: 3,
      vmSize: props.vmSize ?? nodeVmSize,
      placementProperties: props.placementProperties,
      tags: props.tags,
    });
    return { group, cluster, nodeType };
  });

// A primary node type needs 3 × Standard_D2s_v4 (6 vCPUs of the DSv4
// family). ~$0.60/hour while running, 20-40 minutes to provision and as
// long to delete. Run with AZURE_TEST_PAID=1 on an upgraded subscription.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a primary node type",
  (stack) =>
    withVcpus(4)(
      withPublicIps(1)(
        Effect.gen(function* () {
          yield* stack.destroy();

          const { group, cluster, nodeType } = yield* stack.deploy(
            program({ tags: { env: "test" } }),
          );
          const get = () =>
            getNodeType(
              group.resourceGroupName,
              cluster.managedClusterName,
              nodeType.nodeTypeName,
            );
          expect(nodeType.isPrimary).toEqual(true);
          expect(nodeType.vmInstanceCount).toEqual(3);
          const observed = yield* get();
          expect(observed.properties?.provisioningState).toEqual("Succeeded");
          expect(observed.properties?.vmSize).toEqual(nodeVmSize);

          // In-place: placement properties and tags.
          const updated = yield* stack.deploy(
            program({
              tags: { env: "prod" },
              placementProperties: { role: "system" },
            }),
          );
          expect(updated.nodeType.nodeTypeId).toEqual(nodeType.nodeTypeId);
          const reobserved = yield* get();
          expect(reobserved.tags?.env).toEqual("prod");
          expect(reobserved.properties?.placementProperties?.role).toEqual(
            "system",
          );

          yield* stack.destroy();
          expect(yield* waitGone(get(), 90)).toEqual("gone");
        }),
      ),
    ).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);

// Ungated probe (~$0.01, ~9 minutes): the subscription's Dv5/DSv5 family
// quota is 0, so a 3-node Standard_D2s_v5 primary node type fails with the
// typed `QuotaExceeded` error. The node-less cluster is cleaned up by the
// final destroy.
test.provider(
  "a primary node type exceeds the DSv5-family vCPU quota",
  (stack) =>
    withVcpus(4)(
      withPublicIps(1)(
        Effect.gen(function* () {
          yield* stack.destroy();
          const error = yield* stack
            .deploy(
              program({
                tags: { env: "test" },
                vmSize: "Standard_D2s_v5",
                location: "westus2",
              }),
            )
            .pipe(Effect.flip);
          expect(error._tag).toEqual("QuotaExceeded");
          yield* stack.destroy();
        }),
      ),
    ).pipe(logLevel),
  { tags, timeout: 900_000 },
);
