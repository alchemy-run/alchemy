import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as aks from "@distilled.cloud/azure/hybridaks";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  customLocationId,
  hciLocation,
  logicalNetworkId,
  logLevel,
  missingCustomLocation,
  sshPublicKey,
  subscription,
  tags,
  waitGone,
  withConnectedCluster,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPool = (connectedClusterResourceUri: string, agentPoolName: string) =>
  aks.GetAgentPool({ connectedClusterResourceUri, agentPoolName });

const deployGroup = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: hciLocation(),
  });
  return { group };
});

const deployCluster = (connectedClusterId: string) =>
  Effect.gen(function* () {
    const { group } = yield* deployGroup;
    const cluster = yield* Azure.HybridContainerService.ProvisionedCluster(
      "Cluster",
      {
        connectedClusterId,
        extendedLocation: { name: customLocationId() },
        sshPublicKeys: [sshPublicKey],
        controlPlane: { count: 1, vmSize: "Standard_A4_v2" },
        vnetSubnetIds: [logicalNetworkId()],
        agentPoolProfiles: [
          {
            name: "nodepool1",
            count: 1,
            osType: "Linux",
            vmSize: "Standard_A4_v2",
          },
        ],
      },
    );
    return { group, cluster };
  });

const program = (
  connectedClusterId: string,
  props: { count: number; vmSize: string; tags: Record<string, string> },
) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* deployCluster(connectedClusterId);
    const pool = yield* Azure.HybridContainerService.AgentPool("Pool", {
      connectedClusterId: cluster.connectedClusterId,
      extendedLocation: { name: customLocationId() },
      osType: "Linux",
      vmSize: props.vmSize,
      count: props.count,
      nodeLabels: { workload: "test" },
      tags: props.tags,
    });
    return { group, cluster, pool };
  });

// A node pool adds VMs on Azure Local hardware to an AKS Arc cluster behind
// an Arc custom location, which the free trial does not have. Set
// AZURE_TEST_PAID=1, AZURE_TEST_HCI_CUSTOM_LOCATION, AZURE_TEST_HCI_LOCATION
// and AZURE_TEST_AKSARC_LOGICAL_NETWORK on a subscription with an Azure
// Local cluster. Cluster + pool provisioning take ~30-60 minutes, so the
// timeout is the contract maximum and may need raising.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an AKS Arc AgentPool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(deployGroup);

      yield* withConnectedCluster(
        group.resourceGroupName,
        hciLocation(),
        (connectedClusterId) =>
          Effect.gen(function* () {
            const { pool } = yield* stack.deploy(
              program(connectedClusterId, {
                count: 1,
                vmSize: "Standard_A4_v2",
                tags: { env: "a" },
              }),
            );
            const observed = yield* getPool(
              connectedClusterId,
              pool.agentPoolName,
            );
            expect(observed.properties?.count).toEqual(1);
            expect(observed.properties?.nodeLabels?.workload).toEqual("test");
            expect(observed.tags?.env).toEqual("a");

            // In place: node count and tags.
            const updated = yield* stack.deploy(
              program(connectedClusterId, {
                count: 2,
                vmSize: "Standard_A4_v2",
                tags: { env: "b" },
              }),
            );
            expect(updated.pool.agentPoolId).toEqual(pool.agentPoolId);
            const scaled = yield* getPool(
              connectedClusterId,
              pool.agentPoolName,
            );
            expect(scaled.properties?.count).toEqual(2);
            expect(scaled.tags?.env).toEqual("b");

            // Replacement: the VM size is immutable.
            const replaced = yield* stack.deploy(
              program(connectedClusterId, {
                count: 1,
                vmSize: "Standard_A2_v2",
                tags: { env: "b" },
              }),
            );
            expect(replaced.pool.agentPoolName).not.toEqual(pool.agentPoolName);
            expect(
              yield* waitGone(getPool(connectedClusterId, pool.agentPoolName)),
            ).toEqual("gone");

            yield* stack.deploy(deployCluster(connectedClusterId));
            expect(
              yield* waitGone(
                getPool(connectedClusterId, replaced.pool.agentPoolName),
              ),
            ).toEqual("gone");
            yield* stack.deploy(deployGroup);
          }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free: a resource group and a bare connected-cluster
// record): without an Azure Local custom location the PUT is rejected with
// the typed error, and the pool reads as a typed not-found.
test.provider(
  "a missing custom location rejects the AKS Arc AgentPool with a typed error",
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
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.HybridContainerService",
      );
      yield* withConnectedCluster(
        group.resourceGroupName,
        "eastus",
        (connectedClusterId) =>
          Effect.gen(function* () {
            const getError = yield* getPool(connectedClusterId, "probe").pipe(
              Effect.flip,
            );
            expect(getError._tag).toEqual("ResourceNotFound");
            const error = yield* aks
              .AgentPoolCreateOrUpdate({
                connectedClusterResourceUri: connectedClusterId,
                agentPoolName: "probe",
                extendedLocation: {
                  type: "CustomLocation",
                  name: missingCustomLocation(
                    subscriptionId,
                    group.resourceGroupName,
                  ),
                },
                properties: { count: 1, osType: "Linux" },
              })
              .pipe(Effect.flip);
            expect(error._tag).toEqual("CustomLocationNotFound");
          }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
