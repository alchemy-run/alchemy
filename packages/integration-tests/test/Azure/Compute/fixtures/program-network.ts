import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { VM_SIZE } from "../helpers.ts";

/** Region of the program VMs (the stack's default group is created here too). */
export const PROGRAM_LOCATION = "eastus";

/**
 * 1-vCPU F-series v7 size (~$0.04/hour). The B-series has no quota on the
 * testing subscription: `standardBasv2Family` is 0 in eastus, and a
 * Microsoft.Quota raise to 4 was not approved within 10 minutes.
 */
export const PROGRAM_VM_SIZE = VM_SIZE;

/** Port the fixture programs listen on (the default). */
export const PROGRAM_PORT = 3000;

/**
 * Network for a VM that serves HTTP: a VNet and subnet, a Standard static
 * public IP, and a network security group that allows TCP {@link PROGRAM_PORT}
 * from anywhere. `prefix` keeps two programs' networks apart in one stack.
 */
export const programNetwork = (prefix: string) =>
  Effect.gen(function* () {
    const vnet = yield* Azure.Network.VirtualNetwork(`${prefix}Vnet`, {
      location: PROGRAM_LOCATION,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet(`${prefix}Subnet`, {
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const ip = yield* Azure.Network.PublicIpAddress(`${prefix}Ip`, {
      location: PROGRAM_LOCATION,
      sku: "Standard",
      allocationMethod: "Static",
    });
    const nsg = yield* Azure.Network.NetworkSecurityGroup(`${prefix}Nsg`, {
      location: PROGRAM_LOCATION,
    });
    yield* Azure.Network.SecurityRule(`${prefix}Http`, {
      networkSecurityGroup: nsg.networkSecurityGroupName,
      priority: 100,
      direction: "Inbound",
      access: "Allow",
      protocol: "Tcp",
      sourceAddressPrefix: "*",
      sourcePortRange: "*",
      destinationAddressPrefix: "*",
      destinationPortRange: String(PROGRAM_PORT),
    });
    const nic = yield* Azure.Network.NetworkInterface(`${prefix}Nic`, {
      location: PROGRAM_LOCATION,
      ipConfigurations: [{ subnetId: subnet.subnetId, publicIpAddressId: ip.publicIpAddressId }],
      networkSecurityGroupId: nsg.networkSecurityGroupId,
    });
    return { nic, ip };
  });
