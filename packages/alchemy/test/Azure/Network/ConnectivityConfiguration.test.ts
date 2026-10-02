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

const getConfiguration = (
  resourceGroupName: string,
  networkManagerName: string,
  configurationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetConnectivityConfiguration({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      configurationName,
    }),
  );

// Undeployed connectivity configurations are free.
const program = (props: {
  description: string;
  groupConnectivity: "None" | "DirectlyConnected";
}) =>
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
    const configuration = yield* Azure.Network.ConnectivityConfiguration(
      "Mesh",
      {
        resourceGroup: group.resourceGroupName,
        networkManager: manager.networkManagerName,
        description: props.description,
        connectivityTopology: "Mesh",
        appliesToGroups: [
          {
            networkGroupId: networkGroup.networkGroupId,
            groupConnectivity: props.groupConnectivity,
          },
        ],
      },
    );
    return { group, manager, networkGroup, configuration };
  });

test.provider(
  "create, update, and delete a connectivity configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, networkGroup, configuration } =
        yield* stack.deploy(
          program({ description: "one", groupConnectivity: "None" }),
        );
      expect(configuration.connectivityTopology).toEqual("Mesh");
      expect(
        configuration.networkGroupIds.map((id) => id.toLowerCase()),
      ).toEqual([networkGroup.networkGroupId.toLowerCase()]);

      const updated = yield* stack.deploy(
        program({ description: "two", groupConnectivity: "DirectlyConnected" }),
      );
      expect(updated.configuration.configurationId).toEqual(
        configuration.configurationId,
      );
      const observed = yield* getConfiguration(
        group.resourceGroupName,
        manager.networkManagerName,
        configuration.configurationName,
      );
      expect(observed.properties?.description).toEqual("two");
      expect(
        observed.properties?.appliesToGroups[0]?.groupConnectivity,
      ).toEqual("DirectlyConnected");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConfiguration(
            group.resourceGroupName,
            manager.networkManagerName,
            configuration.configurationName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withNetworkManager, logLevel),
  { tags, timeout: 600_000 },
);
