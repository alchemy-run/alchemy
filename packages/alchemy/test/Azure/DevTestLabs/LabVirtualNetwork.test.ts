import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { labFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNetwork = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetVirtualNetwork({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

const program = (props: {
  publicIp: "Allow" | "Deny";
  description: string;
}) =>
  Effect.gen(function* () {
    const { group, lab } = yield* labFixture();
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      addressPrefixes: ["10.20.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("LabSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.20.1.0/24",
    });
    const network = yield* Azure.DevTestLabs.LabVirtualNetwork("LabNet", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      externalProviderResourceId: vnet.virtualNetworkId,
      description: props.description,
      subnetOverrides: [
        {
          resourceId: subnet.subnetId,
          labSubnetName: subnet.subnetName,
          useInVmCreationPermission: "Allow",
          usePublicIpAddressPermission: props.publicIp,
        },
      ],
    });
    return { group, lab, vnet, subnet, network };
  });

// Free lab + VNet; ~5 minutes for the lab.
test.provider(
  "create, update, and delete a lab virtual network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, vnet, network } = yield* stack.deploy(
        program({ publicIp: "Deny", description: "first" }),
      );
      const get = () =>
        getNetwork(
          group.resourceGroupName,
          lab.labName,
          network.labVirtualNetworkName,
        );
      const observed = yield* get();
      expect(
        observed.properties?.externalProviderResourceId?.toLowerCase(),
      ).toEqual(vnet.virtualNetworkId.toLowerCase());
      expect(
        observed.properties?.subnetOverrides?.[0]?.usePublicIpAddressPermission,
      ).toEqual("Deny");
      expect(observed.tags?.["alchemy::id"]).toEqual("LabNet");

      // In-place: public IP permission + description.
      const updated = yield* stack.deploy(
        program({ publicIp: "Allow", description: "second" }),
      );
      expect(updated.network.labVirtualNetworkId).toEqual(
        network.labVirtualNetworkId,
      );
      const reobserved = yield* get();
      expect(
        reobserved.properties?.subnetOverrides?.[0]?.usePublicIpAddressPermission,
      ).toEqual("Allow");
      expect(reobserved.properties?.description).toEqual("second");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
