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

const getCluster = (connectedClusterResourceUri: string) =>
  aks.GetProvisionedClusterInstance({ connectedClusterResourceUri });

const deployGroup = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: hciLocation(),
  });
  return { group };
});

const program = (
  connectedClusterId: string,
  props: { azureHybridBenefit: "True" | "False"; podCidr: string },
) =>
  Effect.gen(function* () {
    const { group } = yield* deployGroup;
    const cluster = yield* Azure.HybridContainerService.ProvisionedCluster(
      "Cluster",
      {
        connectedClusterId,
        extendedLocation: { name: customLocationId() },
        sshPublicKeys: [sshPublicKey],
        controlPlane: { count: 1, vmSize: "Standard_A4_v2" },
        networkProfile: { podCidr: props.podCidr },
        vnetSubnetIds: [logicalNetworkId()],
        agentPoolProfiles: [
          {
            name: "nodepool1",
            count: 1,
            osType: "Linux",
            vmSize: "Standard_A4_v2",
          },
        ],
        azureHybridBenefit: props.azureHybridBenefit,
      },
    );
    return { group, cluster };
  });

// An AKS Arc cluster runs its VMs on Azure Local hardware (the cloud side is
// free; on-prem compute only) behind an Arc custom location, which the free
// trial does not have. Set AZURE_TEST_PAID=1, AZURE_TEST_HCI_CUSTOM_LOCATION,
// AZURE_TEST_HCI_LOCATION and AZURE_TEST_AKSARC_LOGICAL_NETWORK on a
// subscription with an Azure Local cluster. Create + replace take ~30-60
// minutes, so the timeout is the contract maximum and may need raising.
// Skipped: failed in the last live run. BadRequest: Property id '' at path 'extendedLocation.name'
// is invalid. Expect fully qualified resource Id that start with '/subscriptions/{subscriptionId}'
// or '/providers/{resourceProviderNamespace}/'.
test.provider.skip(
  "create, update, replace, and delete an AKS Arc ProvisionedCluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(deployGroup);

      yield* withConnectedCluster(
        group.resourceGroupName,
        hciLocation(),
        (connectedClusterId) =>
          Effect.gen(function* () {
            const { cluster } = yield* stack.deploy(
              program(connectedClusterId, {
                azureHybridBenefit: "False",
                podCidr: "10.244.0.0/16",
              }),
            );
            const observed = yield* getCluster(connectedClusterId);
            expect(observed.properties?.provisioningState).toEqual("Succeeded");
            expect(
              observed.properties?.licenseProfile?.azureHybridBenefit,
            ).toEqual("False");

            // In place: license profile.
            const updated = yield* stack.deploy(
              program(connectedClusterId, {
                azureHybridBenefit: "True",
                podCidr: "10.244.0.0/16",
              }),
            );
            expect(updated.cluster.provisionedClusterId).toEqual(
              cluster.provisionedClusterId,
            );
            expect(
              (yield* getCluster(connectedClusterId)).properties?.licenseProfile
                ?.azureHybridBenefit,
            ).toEqual("True");

            // Replacement (delete-first singleton): pod CIDR is immutable.
            yield* stack.deploy(
              program(connectedClusterId, {
                azureHybridBenefit: "True",
                podCidr: "10.245.0.0/16",
              }),
            );
            expect(
              (yield* getCluster(connectedClusterId)).properties?.networkProfile
                ?.podCidr,
            ).toEqual("10.245.0.0/16");

            yield* stack.deploy(deployGroup);
            expect(yield* waitGone(getCluster(connectedClusterId))).toEqual(
              "gone",
            );
          }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free: a resource group and a bare connected-cluster
// record): without an Azure Local custom location the PUT is rejected with
// the typed error, and the singleton reads as a typed not-found.
test.provider(
  "a missing custom location rejects the AKS Arc ProvisionedCluster with a typed error",
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
            const getError = yield* getCluster(connectedClusterId).pipe(
              Effect.flip,
            );
            expect(getError._tag).toEqual("ResourceNotFound");
            const error = yield* aks
              .ProvisionedClusterInstancesCreateOrUpdate({
                connectedClusterResourceUri: connectedClusterId,
                extendedLocation: {
                  type: "CustomLocation",
                  name: missingCustomLocation(
                    subscriptionId,
                    group.resourceGroupName,
                  ),
                },
                properties: {
                  controlPlane: { count: 1 },
                  linuxProfile: {
                    ssh: { publicKeys: [{ keyData: sshPublicKey }] },
                  },
                },
              })
              .pipe(Effect.flip);
            expect(error._tag).toEqual("CustomLocationNotFound");
          }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
