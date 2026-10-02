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

const getNat = (resourceGroupName: string, natGatewayName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNatGateway({
      subscriptionId,
      resourceGroupName,
      natGatewayName,
    }),
  );

// NAT gateway ~$0.045/hour + Standard public IP ~$0.005/hour; the test
// runs for a few minutes (well under $0.01).
const program = (props: {
  idleTimeoutInMinutes: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ip = yield* Azure.Network.PublicIpAddress("EgressIp", {
      resourceGroup: group.resourceGroupName,
    });
    const nat = yield* Azure.Network.NatGateway("Egress", {
      resourceGroup: group.resourceGroupName,
      publicIpAddressIds: [ip.publicIpAddressId],
      idleTimeoutInMinutes: props.idleTimeoutInMinutes,
      tags: props.tags,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("App", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
      natGatewayId: nat.natGatewayId,
    });
    return { group, ip, nat, subnet };
  });

test.provider(
  "create, update, and delete a NAT gateway attached to a subnet",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ip, nat, subnet } = yield* stack.deploy(
        program({ idleTimeoutInMinutes: 4, tags: { env: "test" } }),
      );
      expect(nat.sku).toEqual("Standard");
      expect(nat.publicIpAddressIds.map((id) => id.toLowerCase())).toEqual([
        ip.publicIpAddressId.toLowerCase(),
      ]);
      expect(subnet.natGatewayId?.toLowerCase()).toEqual(
        nat.natGatewayId.toLowerCase(),
      );
      const observed = yield* getNat(
        group.resourceGroupName,
        nat.natGatewayName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.idleTimeoutInMinutes).toEqual(4);
      expect(
        observed.properties?.subnets?.map((s) => s.id?.toLowerCase()),
      ).toEqual([subnet.subnetId.toLowerCase()]);

      const updated = yield* stack.deploy(
        program({ idleTimeoutInMinutes: 10, tags: { env: "prod" } }),
      );
      expect(updated.nat.natGatewayId).toEqual(nat.natGatewayId);
      const reobserved = yield* getNat(
        group.resourceGroupName,
        nat.natGatewayName,
      );
      expect(reobserved.properties?.idleTimeoutInMinutes).toEqual(10);
      expect(reobserved.tags?.env).toEqual("prod");
      // The PUT must keep the subnet association.
      expect(reobserved.properties?.subnets?.length).toEqual(1);

      yield* stack.destroy();
      expect(
        yield* untilGone(getNat(group.resourceGroupName, nat.natGatewayName)),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 600_000 },
);
