import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as discovery from "@distilled.cloud/azure/discovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  probeGroup,
  subscription,
  supercomputerPrerequisites,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNodePool = (
  resourceGroupName: string,
  supercomputerName: string,
  nodePoolName: string,
) =>
  Effect.gen(function* () {
    return yield* discovery.GetNodePool({
      subscriptionId: yield* subscription,
      resourceGroupName,
      supercomputerName,
      nodePoolName,
    });
  });

const program = (props: { vmSize: string; maxNodeCount: number }) =>
  Effect.gen(function* () {
    const prereqs = yield* supercomputerPrerequisites;
    const supercomputer = yield* Azure.Discovery.Supercomputer("Super", {
      resourceGroup: prereqs.group.resourceGroupName,
      subnetId: prereqs.system.subnetId,
      managementSubnetId: prereqs.management.subnetId,
      clusterIdentity: prereqs.cluster.identityId,
      kubeletIdentity: prereqs.kubelet.identityId,
    });
    const pool = yield* Azure.Discovery.NodePool("Gpus", {
      resourceGroup: prereqs.group.resourceGroupName,
      supercomputer: supercomputer.supercomputerName,
      subnetId: prereqs.nodes.subnetId,
      vmSize: props.vmSize,
      minNodeCount: 0,
      maxNodeCount: props.maxNodeCount,
    });
    return { group: prereqs.group, supercomputer, pool };
  });

// Microsoft Discovery is a gated preview: ARM does not expose its resource
// types to the trial subscription (InvalidResourceType, see the probe),
// and GPU quota is 0 on the trial. Needs a supercomputer (30+ minutes,
// ~$1-2); the GPU pool scales from zero (~$0.53/hour per T4 node, ~$3.7 per
// A100 node if a node starts). Runs only with AZURE_TEST_PAID=1.
// Skipped: failed in the last live run. InvalidResourceType: The resource type could not be found
// in the namespace 'Microsoft.Discovery' for api version '2026-06-01'.
test.provider.skip(
  "create, update, replace, and delete a discovery node pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, supercomputer, pool } = yield* stack.deploy(
        program({ vmSize: "Standard_NC4as_T4_v3", maxNodeCount: 1 }),
      );
      const get = (name: string) =>
        getNodePool(
          group.resourceGroupName,
          supercomputer.supercomputerName,
          name,
        );
      const observed = yield* get(pool.nodePoolName);
      expect(observed.properties?.maxNodeCount).toEqual(1);

      // In place: node count bounds.
      const updated = yield* stack.deploy(
        program({ vmSize: "Standard_NC4as_T4_v3", maxNodeCount: 2 }),
      );
      expect(updated.pool.nodePoolId).toEqual(pool.nodePoolId);
      expect((yield* get(pool.nodePoolName)).properties?.maxNodeCount).toEqual(
        2,
      );

      // The VM size is create-only.
      const replaced = yield* stack.deploy(
        program({ vmSize: "Standard_NC8as_T4_v3", maxNodeCount: 2 }),
      );
      expect(replaced.pool.nodePoolName).not.toEqual(pool.nodePoolName);
      expect(yield* waitGone(get(pool.nodePoolName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.pool.nodePoolName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider(
  "discovery node pools are rejected where the preview is not enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      const error = yield* discovery
        .NodePoolsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          supercomputerName: "alchemy-probe",
          nodePoolName: "alchemy-probe",
          location,
          properties: {
            subnetId: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Network/virtualNetworks/probe/subnets/probe`,
            vmSize: "Standard_NC4as_T4_v3",
            maxNodeCount: 1,
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
