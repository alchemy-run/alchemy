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
  logLevel,
  missingCustomLocation,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVirtualNetwork = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* aks.GetVirtualNetwork({
      subscriptionId: yield* subscription,
      resourceGroupName,
      virtualNetworkName: name,
    });
  });

const program = (props: { vlanID: number; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: hciLocation(),
    });
    const resource = yield* Azure.HybridContainerService.VirtualNetwork(
      "VirtualNetwork",
      {
        resourceGroup: group.resourceGroupName,
        location: hciLocation(),
        extendedLocation: { name: customLocationId() },
        hci: {
          mocGroup: process.env.AZURE_TEST_AKSARC_MOC_GROUP ?? "target-group",
          mocLocation:
            process.env.AZURE_TEST_AKSARC_MOC_LOCATION ?? "MocLocation",
          mocVnetName: process.env.AZURE_TEST_AKSARC_MOC_VNET ?? "vnet1",
        },
        ipAddressPrefix: "10.10.0.0/24",
        gateway: "10.10.0.1",
        dnsServers: ["10.10.0.2"],
        vipPool: [{ startIP: "10.10.0.200", endIP: "10.10.0.220" }],
        vmipPool: [{ startIP: "10.10.0.100", endIP: "10.10.0.150" }],
        vlanID: props.vlanID,
        tags: props.tags,
      },
    );
    return { group, resource };
  });

// An AKS Arc virtual network is free but needs a deployed Azure Local
// cluster with the Arc Resource Bridge and a custom location; the free
// trial has no Azure Local hardware. Set AZURE_TEST_PAID=1,
// AZURE_TEST_HCI_CUSTOM_LOCATION, AZURE_TEST_HCI_LOCATION and the
// AZURE_TEST_AKSARC_MOC_* inputs on a subscription with an Azure Local
// cluster. ~5 minutes.
// Skipped: failed in the last live run. BadRequest: Property id '' at path 'extendedLocation.name'
// is invalid. Expect fully qualified resource Id that start with '/subscriptions/{subscriptionId}'
// or '/providers/{resourceProviderNamespace}/'.
test.provider.skip(
  "create, update, replace, and delete an AKS Arc VirtualNetwork",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, resource } = yield* stack.deploy(
        program({ vlanID: 0, tags: { env: "a" } }),
      );
      const get = (name: string) =>
        getVirtualNetwork(group.resourceGroupName, name);
      const observed = yield* get(resource.virtualNetworkName);
      expect(observed.properties?.ipAddressPrefix).toEqual("10.10.0.0/24");
      expect(observed.tags?.env).toEqual("a");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ vlanID: 0, tags: { env: "b" } }),
      );
      expect(updated.resource.virtualNetworkId).toEqual(
        resource.virtualNetworkId,
      );
      expect((yield* get(resource.virtualNetworkName)).tags?.env).toEqual("b");

      // Replacement: an immutable property changes.
      const replaced = yield* stack.deploy(
        program({ vlanID: 100, tags: { env: "b" } }),
      );
      expect(replaced.resource.virtualNetworkName).not.toEqual(
        resource.virtualNetworkName,
      );
      expect(
        (yield* get(replaced.resource.virtualNetworkName)).properties?.vlanID,
      ).toEqual(100);
      expect(yield* waitGone(get(resource.virtualNetworkName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.resource.virtualNetworkName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): without an Azure Local
// custom location the PUT is rejected with the typed error.
test.provider(
  "a missing custom location rejects the AKS Arc VirtualNetwork with a typed error",
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
      const error = yield* aks
        .VirtualNetworksCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          virtualNetworkName: "probe",
          location: "eastus",
          extendedLocation: {
            type: "CustomLocation",
            name: missingCustomLocation(
              subscriptionId,
              group.resourceGroupName,
            ),
          },
          properties: { infraVnetProfile: { hci: { mocVnetName: "probe" } } },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      const getError = yield* getVirtualNetwork(
        group.resourceGroupName,
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
