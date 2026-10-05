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

const getNetworkGroup = (
  resourceGroupName: string,
  networkManagerName: string,
  networkGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkGroup({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      networkGroupName,
    }),
  );

// Network Manager resources are free until configurations are deployed.
const program = (props: { description: string; name: string }) =>
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
      description: props.description,
      name: props.name,
    });
    return { group, manager, networkGroup };
  });

test.provider(
  "create, update, replace, and delete a network group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, networkGroup } = yield* stack.deploy(
        program({ description: "one", name: "spokes-a" }),
      );
      expect(networkGroup.networkGroupName).toEqual("spokes-a");
      const observed = yield* getNetworkGroup(
        group.resourceGroupName,
        manager.networkManagerName,
        networkGroup.networkGroupName,
      );
      expect(observed.properties?.description).toEqual("one");

      const updated = yield* stack.deploy(
        program({ description: "two", name: "spokes-a" }),
      );
      expect(updated.networkGroup.networkGroupId).toEqual(
        networkGroup.networkGroupId,
      );
      expect(
        (yield* getNetworkGroup(
          group.resourceGroupName,
          manager.networkManagerName,
          networkGroup.networkGroupName,
        )).properties?.description,
      ).toEqual("two");

      // Renaming replaces the group.
      const replaced = yield* stack.deploy(
        program({ description: "two", name: "spokes-b" }),
      );
      expect(replaced.networkGroup.networkGroupName).not.toEqual(
        networkGroup.networkGroupName,
      );
      expect(replaced.networkGroup.networkGroupName).toEqual("spokes-b");
      expect(
        yield* untilGone(
          getNetworkGroup(
            group.resourceGroupName,
            manager.networkManagerName,
            networkGroup.networkGroupName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getNetworkGroup(
            group.resourceGroupName,
            manager.networkManagerName,
            replaced.networkGroup.networkGroupName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withNetworkManager, logLevel),
  { tags, timeout: 600_000 },
);
