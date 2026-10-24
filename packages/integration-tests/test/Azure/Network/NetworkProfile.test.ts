import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProfile = (resourceGroupName: string, networkProfileName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkProfile({ subscriptionId, resourceGroupName, networkProfileName }),
  );

// VNets, subnets, and network profiles are free.
const program = (props: { ipConfigurationName: string; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.60.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Aci", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.60.1.0/24",
      delegations: [{ serviceName: "Microsoft.ContainerInstance/containerGroups" }],
    });
    const profile = yield* Azure.Network.NetworkProfile("AciProfile", {
      resourceGroup: group.resourceGroupName,
      containerNetworkInterfaceConfigurations: [
        {
          name: "eth0",
          ipConfigurations: [{ name: props.ipConfigurationName, subnetId: subnet.subnetId }],
        },
      ],
      tags: { env: props.env },
    });
    return { group, subnet, profile };
  });

test.provider(
  "create, update, and delete a network profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, subnet, profile } = yield* stack.deploy(
        program({ ipConfigurationName: "ipconfig", env: "test" }),
      );
      const observed = yield* getProfile(group.resourceGroupName, profile.networkProfileName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      const configuration = observed.properties?.containerNetworkInterfaceConfigurations?.[0];
      expect(configuration?.name).toEqual("eth0");
      expect(configuration?.properties?.ipConfigurations?.[0]?.name).toEqual("ipconfig");
      expect(
        configuration?.properties?.ipConfigurations?.[0]?.properties?.subnet?.id?.toLowerCase(),
      ).toEqual(subnet.subnetId.toLowerCase());
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ ipConfigurationName: "ipconfig2", env: "prod" }),
      );
      expect(updated.profile.networkProfileId).toEqual(profile.networkProfileId);
      const reobserved = yield* getProfile(group.resourceGroupName, profile.networkProfileName);
      expect(
        reobserved.properties?.containerNetworkInterfaceConfigurations?.[0]?.properties
          ?.ipConfigurations?.[0]?.name,
      ).toEqual("ipconfig2");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getProfile(group.resourceGroupName, profile.networkProfileName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
