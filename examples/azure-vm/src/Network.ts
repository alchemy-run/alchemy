import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { LOCATION, PORT } from "./resources.ts";

/**
 * Network for a VM that serves HTTP: a virtual network and subnet, a
 * Standard static public IP, and a network security group that allows
 * inbound TCP on {@link PORT}. Standard public IPs block inbound traffic
 * until a security group allows it.
 */
export const Network = Effect.gen(function* () {
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    location: LOCATION,
    addressPrefixes: ["10.0.0.0/16"],
  });
  const subnet = yield* Azure.Network.Subnet("Subnet", {
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.0.1.0/24",
  });
  const ip = yield* Azure.Network.PublicIpAddress("Ip", {
    location: LOCATION,
    sku: "Standard",
    allocationMethod: "Static",
  });
  const nsg = yield* Azure.Network.NetworkSecurityGroup("Nsg", { location: LOCATION });
  yield* Azure.Network.SecurityRule("AllowHttp", {
    networkSecurityGroup: nsg.networkSecurityGroupName,
    priority: 100,
    direction: "Inbound",
    access: "Allow",
    protocol: "Tcp",
    sourceAddressPrefix: "*",
    sourcePortRange: "*",
    destinationAddressPrefix: "*",
    destinationPortRange: String(PORT),
  });
  const nic = yield* Azure.Network.NetworkInterface("Nic", {
    location: LOCATION,
    ipConfigurations: [{ subnetId: subnet.subnetId, publicIpAddressId: ip.publicIpAddressId }],
    networkSecurityGroupId: nsg.networkSecurityGroupId,
  });
  return { nic, ip };
});
