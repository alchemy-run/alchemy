import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * Resource group + VNet + `GatewaySubnet` + Standard public IP + route-based
 * VPN gateway (eastus). A gateway takes 30-45 minutes to provision and
 * bills ~$0.19/hour (VpnGw1AZ) to ~$0.49/hour (VpnGw2AZ), so every test
 * built on it is gated behind AZURE_TEST_EXPENSIVE=1.
 */
export const vpnGateway = (props: {
  sku: "VpnGw1AZ" | "VpnGw2AZ";
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.70.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("GatewaySubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      name: "GatewaySubnet",
      addressPrefix: "10.70.255.0/27",
    });
    const ip = yield* Azure.Network.PublicIpAddress("GatewayIp", {
      resourceGroup: group.resourceGroupName,
      zones: ["1", "2", "3"],
    });
    const gateway = yield* Azure.Network.VirtualNetworkGateway("Vpn", {
      resourceGroup: group.resourceGroupName,
      sku: props.sku,
      generation: "Generation2",
      subnetId: subnet.subnetId,
      publicIpAddressIds: [ip.publicIpAddressId],
      tags: props.tags,
    });
    return { group, vnet, subnet, ip, gateway };
  });

/**
 * Resource group + VNet + `RouteServerSubnet` + virtual router (eastus).
 * The router bills ~$0.45/hour and takes ~20 minutes to provision, so
 * every test built on it is gated behind AZURE_TEST_EXPENSIVE=1.
 */
export const routeServer = (env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.80.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("RouteServerSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      name: "RouteServerSubnet",
      addressPrefix: "10.80.255.0/27",
    });
    const router = yield* Azure.Network.VirtualRouter("Router", {
      resourceGroup: group.resourceGroupName,
      hostedSubnetId: subnet.subnetId,
      tags: { env },
    });
    return { group, vnet, subnet, router };
  });
