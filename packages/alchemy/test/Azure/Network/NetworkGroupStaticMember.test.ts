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
  withNetworkManager,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMember = (
  resourceGroupName: string,
  networkManagerName: string,
  networkGroupName: string,
  staticMemberName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetStaticMember({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      networkGroupName,
      staticMemberName,
    }),
  );

// VNets and undeployed Network Manager resources are free.
const program = (member: "A" | "B") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const manager = yield* Azure.Network.NetworkManager("Manager", {
      resourceGroup: group.resourceGroupName,
      scopeAccesses: ["Connectivity"],
    });
    const networkGroup = yield* Azure.Network.NetworkGroup("Spokes", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
    });
    // Both VNets stay deployed across the replacement.
    const vnetA = yield* Azure.Network.VirtualNetwork("VnetA", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.1.0.0/16"],
    });
    const vnetB = yield* Azure.Network.VirtualNetwork("VnetB", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.2.0.0/16"],
    });
    const memberResource = yield* Azure.Network.NetworkGroupStaticMember(
      "Member",
      {
        resourceGroup: group.resourceGroupName,
        networkManager: manager.networkManagerName,
        networkGroup: networkGroup.networkGroupName,
        resourceId:
          member === "A" ? vnetA.virtualNetworkId : vnetB.virtualNetworkId,
      },
    );
    return {
      group,
      manager,
      networkGroup,
      vnetA,
      vnetB,
      member: memberResource,
    };
  });

test.provider(
  "create, replace, and delete a network group static member",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, networkGroup, vnetA, member } =
        yield* stack.deploy(program("A"));
      expect(member.resourceId?.toLowerCase()).toEqual(
        vnetA.virtualNetworkId.toLowerCase(),
      );
      const observed = yield* getMember(
        group.resourceGroupName,
        manager.networkManagerName,
        networkGroup.networkGroupName,
        member.staticMemberName,
      );
      expect(observed.properties?.resourceId?.toLowerCase()).toEqual(
        vnetA.virtualNetworkId.toLowerCase(),
      );

      // The member resource ID is immutable: a new member replaces the old one.
      const replaced = yield* stack.deploy(program("B"));
      expect(replaced.member.staticMemberName).not.toEqual(
        member.staticMemberName,
      );
      expect(replaced.member.resourceId?.toLowerCase()).toEqual(
        replaced.vnetB.virtualNetworkId.toLowerCase(),
      );
      expect(
        yield* untilGone(
          getMember(
            group.resourceGroupName,
            manager.networkManagerName,
            networkGroup.networkGroupName,
            member.staticMemberName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getMember(
            group.resourceGroupName,
            manager.networkManagerName,
            networkGroup.networkGroupName,
            replaced.member.staticMemberName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withNetworkManager, logLevel),
  { tags, timeout: 600_000 },
);
