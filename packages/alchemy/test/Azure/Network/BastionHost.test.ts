import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, withPublicIps } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getBastion = (resourceGroupName: string, bastionHostName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetBastionHost({ subscriptionId, resourceGroupName, bastionHostName }),
  );

// The Developer SKU is only offered in some regions.
const DEVELOPER_REGION = "northcentralus";

const developer = (env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: DEVELOPER_REGION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: DEVELOPER_REGION,
      addressPrefixes: ["10.40.0.0/16"],
    });
    const bastion = yield* Azure.Network.BastionHost("Dev", {
      resourceGroup: group.resourceGroupName,
      location: DEVELOPER_REGION,
      sku: "Developer",
      virtualNetworkId: vnet.virtualNetworkId,
      tags: { env },
    });
    return { group, vnet, bastion };
  });

// The Developer SKU is free.
test.provider(
  "create, update, and delete a Developer bastion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bastion } = yield* stack.deploy(developer("test"));
      expect(bastion.sku).toEqual("Developer");
      const observed = yield* getBastion(
        group.resourceGroupName,
        bastion.bastionHostName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(developer("prod"));
      expect(updated.bastion.bastionHostId).toEqual(bastion.bastionHostId);
      const reobserved = yield* getBastion(
        group.resourceGroupName,
        bastion.bastionHostName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getBastion(group.resourceGroupName, bastion.bastionHostName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

const standard = (sku: "Basic" | "Standard") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.41.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("AzureBastionSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      name: "AzureBastionSubnet",
      addressPrefix: "10.41.0.0/26",
    });
    const ip = yield* Azure.Network.PublicIpAddress("BastionIp", {
      resourceGroup: group.resourceGroupName,
    });
    const bastion = yield* Azure.Network.BastionHost("Ops", {
      resourceGroup: group.resourceGroupName,
      sku,
      subnetId: subnet.subnetId,
      publicIpAddressId: ip.publicIpAddressId,
      enableTunneling: sku === "Standard" ? true : undefined,
    });
    return { group, vnet, subnet, ip, bastion };
  });

// Basic → Standard upgrade in place, then a downgrade replaces. Basic
// ≈$0.19/hour, Standard ≈$0.29/hour, each step 5-10 minutes: ≈$0.30 and
// ~40 minutes per run.
test.provider.skipIf(!runExpensive)(
  "upgrade and replace a Basic/Standard bastion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bastion } = yield* stack.deploy(standard("Basic"));
      expect(bastion.sku).toEqual("Basic");

      const upgraded = yield* stack.deploy(standard("Standard"));
      expect(upgraded.bastion.bastionHostId).toEqual(bastion.bastionHostId);
      const observed = yield* getBastion(
        group.resourceGroupName,
        bastion.bastionHostName,
      );
      expect(observed.sku?.name).toEqual("Standard");
      expect(observed.properties?.enableTunneling).toEqual(true);

      const downgraded = yield* stack.deploy(standard("Basic"));
      expect(downgraded.bastion.bastionHostName).not.toEqual(
        bastion.bastionHostName,
      );

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getBastion(group.resourceGroupName, downgraded.bastion.bastionHostName),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 7_200_000 },
);
