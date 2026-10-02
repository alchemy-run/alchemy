import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  subscriptionId,
  tags,
  untilGone,
  withPublicIps,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNic = (resourceGroupName: string, networkInterfaceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkInterface({
      subscriptionId,
      resourceGroupName,
      networkInterfaceName,
    }),
  );

// NICs are free; the Standard public IP is ~$0.005/hour for a few minutes.
const program = (props: { staticIp: boolean; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("App", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const nsg = yield* Azure.Network.NetworkSecurityGroup("Nsg", {
      resourceGroup: group.resourceGroupName,
    });
    const ip = yield* Azure.Network.PublicIpAddress("VmIp", {
      resourceGroup: group.resourceGroupName,
    });
    const nic = yield* Azure.Network.NetworkInterface("Vm", {
      resourceGroup: group.resourceGroupName,
      ipConfigurations: [
        props.staticIp
          ? {
              subnetId: subnet.subnetId,
              privateIpAddress: "10.0.1.10",
              publicIpAddressId: ip.publicIpAddressId,
            }
          : { subnetId: subnet.subnetId },
      ],
      networkSecurityGroupId: props.staticIp
        ? nsg.networkSecurityGroupId
        : undefined,
      tags: props.tags,
    });
    return { group, subnet, nsg, ip, nic };
  });

test.provider(
  "create, update, and delete a network interface",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, subnet, nic } = yield* stack.deploy(
        program({ staticIp: false, tags: { env: "test" } }),
      );
      expect(nic.privateIpAddress).toMatch(/^10\.0\.1\.\d+$/);
      const observed = yield* getNic(
        group.resourceGroupName,
        nic.networkInterfaceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      const config = observed.properties?.ipConfigurations?.[0]?.properties;
      expect(config?.privateIPAllocationMethod).toEqual("Dynamic");
      expect(config?.subnet?.id?.toLowerCase()).toEqual(
        subnet.subnetId.toLowerCase(),
      );
      expect(config?.publicIPAddress).toBeUndefined();
      expect(observed.tags?.env).toEqual("test");

      // In place: static IP, public IP, NSG, tags.
      const updated = yield* stack.deploy(
        program({ staticIp: true, tags: { env: "prod" } }),
      );
      expect(updated.nic.networkInterfaceId).toEqual(nic.networkInterfaceId);
      expect(updated.nic.privateIpAddress).toEqual("10.0.1.10");
      const reobserved = yield* getNic(
        group.resourceGroupName,
        nic.networkInterfaceName,
      );
      const reconfig = reobserved.properties?.ipConfigurations?.[0]?.properties;
      expect(reconfig?.privateIPAllocationMethod).toEqual("Static");
      expect(reconfig?.publicIPAddress?.id?.toLowerCase()).toEqual(
        updated.ip.publicIpAddressId.toLowerCase(),
      );
      expect(
        reobserved.properties?.networkSecurityGroup?.id?.toLowerCase(),
      ).toEqual(updated.nsg.networkSecurityGroupId.toLowerCase());
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getNic(group.resourceGroupName, nic.networkInterfaceName),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 600_000 },
);
