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

const getRule = (
  resourceGroupName: string,
  networkManagerName: string,
  configurationName: string,
  ruleCollectionName: string,
  ruleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetRoutingRule({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      configurationName,
      ruleCollectionName,
      ruleName,
    }),
  );
const getConfiguration = (
  resourceGroupName: string,
  networkManagerName: string,
  configurationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkManagerRoutingConfiguration({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      configurationName,
    }),
  );

// Undeployed routing configurations are free.
const program = (props: { description: string; nextHop: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const manager = yield* Azure.Network.NetworkManager("Manager", {
      resourceGroup: group.resourceGroupName,
      scopeAccesses: ["Routing"],
    });
    const networkGroup = yield* Azure.Network.NetworkGroup("Spokes", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
    });
    const configuration = yield* Azure.Network.RoutingConfiguration("Egress", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      description: props.description,
    });
    const collection = yield* Azure.Network.RoutingRuleCollection("Routes", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      routingConfiguration: configuration.configurationName,
      description: props.description,
      networkGroupIds: [networkGroup.networkGroupId],
    });
    const rule = yield* Azure.Network.RoutingRule("Default", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      routingConfiguration: configuration.configurationName,
      ruleCollection: collection.ruleCollectionName,
      description: props.description,
      destination: { type: "AddressPrefix", destinationAddress: "0.0.0.0/0" },
      nextHop: {
        nextHopType: "VirtualAppliance",
        nextHopAddress: props.nextHop,
      },
    });
    return { group, manager, configuration, collection, rule };
  });

test.provider(
  "create, update, and delete a routing configuration, collection, and rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, configuration, collection, rule } =
        yield* stack.deploy(
          program({ description: "one", nextHop: "10.0.0.4" }),
        );
      expect(rule.nextHopType).toEqual("VirtualAppliance");
      expect(collection.networkGroupIds.length).toEqual(1);
      const observed = yield* getRule(
        group.resourceGroupName,
        manager.networkManagerName,
        configuration.configurationName,
        collection.ruleCollectionName,
        rule.ruleName,
      );
      expect(observed.properties?.nextHop.nextHopAddress).toEqual("10.0.0.4");

      const updated = yield* stack.deploy(
        program({ description: "two", nextHop: "10.0.0.5" }),
      );
      expect(updated.rule.ruleId).toEqual(rule.ruleId);
      const reobserved = yield* getRule(
        group.resourceGroupName,
        manager.networkManagerName,
        configuration.configurationName,
        collection.ruleCollectionName,
        rule.ruleName,
      );
      expect(reobserved.properties?.nextHop.nextHopAddress).toEqual("10.0.0.5");
      expect(
        (yield* getConfiguration(
          group.resourceGroupName,
          manager.networkManagerName,
          configuration.configurationName,
        )).properties?.description,
      ).toEqual("two");

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
