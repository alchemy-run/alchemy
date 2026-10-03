import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAppliance = (
  resourceGroupName: string,
  virtualNetworkApplianceName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualNetworkAppliance({
      subscriptionId,
      resourceGroupName,
      virtualNetworkApplianceName,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Subnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      name: "VirtualNetworkApplianceSubnet",
      addressPrefix: "10.0.1.0/24",
    });
    const appliance = yield* Azure.Network.VirtualNetworkAppliance(
      "Appliance",
      {
        resourceGroup: group.resourceGroupName,
        subnetId: subnet.subnetId,
        bandwidthInGbps: 10,
        tags: props.tags,
      },
    );
    return { group, vnet, subnet, appliance };
  });

// Preview: the smallest appliance is 10 Gbps and its price is unpublished
// (validation passes on the trial; provisioning time unknown). Gated as
// possibly costly: run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a virtual network appliance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, appliance } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const observed = yield* getAppliance(
        group.resourceGroupName,
        appliance.virtualNetworkApplianceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.appliance.virtualNetworkApplianceId).toEqual(
        appliance.virtualNetworkApplianceId,
      );
      const reobserved = yield* getAppliance(
        group.resourceGroupName,
        appliance.virtualNetworkApplianceName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getAppliance(
            group.resourceGroupName,
            appliance.virtualNetworkApplianceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
