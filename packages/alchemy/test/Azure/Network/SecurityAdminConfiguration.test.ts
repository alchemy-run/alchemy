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
    network.GetSecurityAdminConfiguration({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      configurationName,
    }),
  );

// Undeployed security admin configurations are free.
const program = (description: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const manager = yield* Azure.Network.NetworkManager("Manager", {
      resourceGroup: group.resourceGroupName,
      scopeAccesses: ["SecurityAdmin"],
    });
    const configuration = yield* Azure.Network.SecurityAdminConfiguration(
      "Org",
      {
        resourceGroup: group.resourceGroupName,
        networkManager: manager.networkManagerName,
        description,
      },
    );
    return { group, manager, configuration };
  });

test.provider(
  "create, update, and delete a security admin configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, configuration } = yield* stack.deploy(
        program("one"),
      );
      expect(configuration.description).toEqual("one");

      const updated = yield* stack.deploy(program("two"));
      expect(updated.configuration.configurationId).toEqual(
        configuration.configurationId,
      );
      const observed = yield* getConfiguration(
        group.resourceGroupName,
        manager.networkManagerName,
        configuration.configurationName,
      );
      expect(observed.properties?.description).toEqual("two");

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
