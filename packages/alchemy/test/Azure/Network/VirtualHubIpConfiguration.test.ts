import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, withPublicIps } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfig = (
  resourceGroupName: string,
  virtualHubName: string,
  ipConfigName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualHubIpConfiguration({
      subscriptionId,
      resourceGroupName,
      virtualHubName,
      ipConfigName,
    }),
  );

// An Azure Route Server: a Standard hub without a WAN, routed in a
// RouteServerSubnet.
const program = (env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.30.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("RouteServerSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      name: "RouteServerSubnet",
      addressPrefix: "10.30.0.0/27",
    });
    const ip = yield* Azure.Network.PublicIpAddress("RouterIp", {
      resourceGroup: group.resourceGroupName,
    });
    const hub = yield* Azure.Network.VirtualHub("RouteServer", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
      tags: { env },
    });
    const config = yield* Azure.Network.VirtualHubIpConfiguration("Router", {
      resourceGroup: group.resourceGroupName,
      virtualHub: hub.virtualHubName,
      subnetId: subnet.subnetId,
      publicIpAddressId: ip.publicIpAddressId,
    });
    return { group, vnet, subnet, ip, hub, config };
  });

// Route Server bills ~$0.45/hour and takes ~20 minutes to provision:
// ≈$0.30 and ~40 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a virtual hub IP configuration (Route Server)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub, subnet, config } = yield* stack.deploy(
        program("test"),
      );
      expect(config.subnetId?.toLowerCase()).toEqual(
        subnet.subnetId.toLowerCase(),
      );
      const observed = yield* getConfig(
        group.resourceGroupName,
        hub.virtualHubName,
        config.ipConfigurationName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      const updated = yield* stack.deploy(program("prod"));
      expect(updated.config.ipConfigurationId).toEqual(
        config.ipConfigurationId,
      );
      expect(updated.hub.tags.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConfig(
            group.resourceGroupName,
            hub.virtualHubName,
            config.ipConfigurationName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 900_000 },
);
