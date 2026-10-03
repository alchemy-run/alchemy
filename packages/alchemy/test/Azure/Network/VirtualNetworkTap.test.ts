import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTap = (resourceGroupName: string, tapName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualNetworkTap({
      subscriptionId,
      resourceGroupName,
      tapName,
    }),
  );
const getTapConfig = (
  resourceGroupName: string,
  networkInterfaceName: string,
  tapConfigurationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkInterfaceTapConfiguration({
      subscriptionId,
      resourceGroupName,
      networkInterfaceName,
      tapConfigurationName,
    }),
  );

// VNet TAP and unattached NICs are free (no VMs).
const program = (props: { port: number; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Default", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const collector = yield* Azure.Network.NetworkInterface("Collector", {
      resourceGroup: group.resourceGroupName,
      ipConfigurations: [{ name: "primary", subnetId: subnet.subnetId }],
    });
    const source = yield* Azure.Network.NetworkInterface("Source", {
      resourceGroup: group.resourceGroupName,
      ipConfigurations: [{ name: "primary", subnetId: subnet.subnetId }],
    });
    const tap = yield* Azure.Network.VirtualNetworkTap("Mirror", {
      resourceGroup: group.resourceGroupName,
      destinationNetworkInterfaceIpConfigurationId: Output.interpolate`${collector.networkInterfaceId}/ipConfigurations/primary`,
      destinationPort: props.port,
      tags: { env: props.env },
    });
    const tapConfig = yield* Azure.Network.NetworkInterfaceTapConfiguration(
      "SourceTap",
      {
        resourceGroup: group.resourceGroupName,
        networkInterface: source.networkInterfaceName,
        virtualNetworkTapId: tap.tapId,
      },
    );
    return { group, tap, source, tapConfig };
  });

test.provider(
  "create, update, and delete a virtual network TAP and NIC TAP configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, tap, source, tapConfig } = yield* stack.deploy(
        program({ port: 4789, env: "test" }),
      );
      expect(tapConfig.virtualNetworkTapId?.toLowerCase()).toEqual(
        tap.tapId.toLowerCase(),
      );
      const observed = yield* getTap(group.resourceGroupName, tap.tapName);
      expect(observed.properties?.destinationPort).toEqual(4789);

      const updated = yield* stack.deploy(program({ port: 4789, env: "prod" }));
      expect(updated.tap.tapId).toEqual(tap.tapId);
      const reobserved = yield* getTap(group.resourceGroupName, tap.tapName);
      expect(reobserved.properties?.destinationPort).toEqual(4789);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(
        (yield* getTapConfig(
          group.resourceGroupName,
          source.networkInterfaceName,
          tapConfig.tapConfigurationName,
        )).properties?.virtualNetworkTap?.id?.toLowerCase(),
      ).toEqual(tap.tapId.toLowerCase());

      yield* stack.destroy();
      expect(
        yield* untilGone(getTap(group.resourceGroupName, tap.tapName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
