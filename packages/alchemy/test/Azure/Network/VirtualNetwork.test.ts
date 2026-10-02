import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVnet = (resourceGroupName: string, virtualNetworkName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualNetwork({
      subscriptionId,
      resourceGroupName,
      virtualNetworkName,
    }),
  );

const program = (props: {
  name?: string;
  addressPrefixes: string[];
  dnsServers?: string[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      addressPrefixes: props.addressPrefixes,
      dnsServers: props.dnsServers,
      tags: props.tags,
    });
    const subnet = yield* Azure.Network.Subnet("App", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    return { group, vnet, subnet };
  });

test.provider(
  "create, update, replace, and delete a virtual network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ addressPrefixes: ["10.0.0.0/16"], tags: { env: "test" } }),
      );
      const { group, vnet, subnet } = created;
      expect(vnet.addressPrefixes).toEqual(["10.0.0.0/16"]);
      expect(vnet.virtualNetworkId).toContain(
        `/virtualNetworks/${vnet.virtualNetworkName}`,
      );
      const observed = yield* getVnet(
        group.resourceGroupName,
        vnet.virtualNetworkName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Vnet");
      expect(observed.properties?.subnets?.map((s) => s.name)).toEqual([
        subnet.subnetName,
      ]);

      // In-place update: a second prefix, DNS servers, tags. The VNet PUT
      // must keep the separately-managed subnet.
      const updated = yield* stack.deploy(
        program({
          addressPrefixes: ["10.0.0.0/16", "10.1.0.0/16"],
          dnsServers: ["10.0.0.4"],
          tags: { env: "prod" },
        }),
      );
      expect(updated.vnet.virtualNetworkName).toEqual(vnet.virtualNetworkName);
      expect(updated.vnet.virtualNetworkId).toEqual(vnet.virtualNetworkId);
      const reobserved = yield* getVnet(
        group.resourceGroupName,
        vnet.virtualNetworkName,
      );
      expect(
        [
          ...(reobserved.properties?.addressSpace?.addressPrefixes ?? []),
        ].sort(),
      ).toEqual(["10.0.0.0/16", "10.1.0.0/16"]);
      expect(reobserved.properties?.dhcpOptions?.dnsServers).toEqual([
        "10.0.0.4",
      ]);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.subnets?.map((s) => s.name)).toEqual([
        subnet.subnetName,
      ]);

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-network-vnet-test",
          addressPrefixes: ["10.0.0.0/16"],
          tags: { env: "prod" },
        }),
      );
      expect(replaced.vnet.virtualNetworkName).toEqual(
        "alchemy-network-vnet-test",
      );
      expect(
        yield* untilGone(
          getVnet(group.resourceGroupName, vnet.virtualNetworkName),
        ),
      ).toEqual("gone");
      const fresh = yield* getVnet(
        group.resourceGroupName,
        "alchemy-network-vnet-test",
      );
      expect(fresh.properties?.subnets?.length).toEqual(1);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getVnet(group.resourceGroupName, "alchemy-network-vnet-test"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
