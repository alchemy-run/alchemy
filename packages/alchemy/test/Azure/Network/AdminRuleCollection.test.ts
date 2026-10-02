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

const getCollection = (
  resourceGroupName: string,
  networkManagerName: string,
  configurationName: string,
  ruleCollectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetAdminRuleCollection({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      configurationName,
      ruleCollectionName,
    }),
  );
const getRule = (
  resourceGroupName: string,
  networkManagerName: string,
  configurationName: string,
  ruleCollectionName: string,
  ruleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetAdminRule({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      configurationName,
      ruleCollectionName,
      ruleName,
    }),
  );

// Undeployed security admin configurations are free.
const program = (props: {
  description: string;
  access: "Deny" | "AlwaysAllow";
  ports: string[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const manager = yield* Azure.Network.NetworkManager("Manager", {
      resourceGroup: group.resourceGroupName,
      scopeAccesses: ["SecurityAdmin"],
    });
    const networkGroup = yield* Azure.Network.NetworkGroup("Spokes", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
    });
    const configuration = yield* Azure.Network.SecurityAdminConfiguration(
      "Org",
      {
        resourceGroup: group.resourceGroupName,
        networkManager: manager.networkManagerName,
      },
    );
    const collection = yield* Azure.Network.AdminRuleCollection("Rules", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      securityAdminConfiguration: configuration.configurationName,
      description: props.description,
      networkGroupIds: [networkGroup.networkGroupId],
    });
    const rule = yield* Azure.Network.AdminRule("DenyRemote", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      securityAdminConfiguration: configuration.configurationName,
      ruleCollection: collection.ruleCollectionName,
      protocol: "Tcp",
      access: props.access,
      priority: 100,
      direction: "Inbound",
      sources: [{ addressPrefix: "Internet", addressPrefixType: "ServiceTag" }],
      destinationPortRanges: props.ports,
    });
    return { group, manager, configuration, collection, rule };
  });

test.provider(
  "create, update, and delete an admin rule collection (with a rule)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, configuration, collection, rule } =
        yield* stack.deploy(
          program({ description: "one", access: "Deny", ports: ["22"] }),
        );
      expect(collection.networkGroupIds.length).toEqual(1);
      expect(rule.access).toEqual("Deny");
      const observedRule = yield* getRule(
        group.resourceGroupName,
        manager.networkManagerName,
        configuration.configurationName,
        collection.ruleCollectionName,
        rule.ruleName,
      );
      expect(observedRule.kind).toEqual("Custom");
      expect(observedRule.properties?.destinationPortRanges).toEqual(["22"]);
      expect(observedRule.properties?.sources?.[0]?.addressPrefix).toEqual(
        "Internet",
      );

      const updated = yield* stack.deploy(
        program({
          description: "two",
          access: "AlwaysAllow",
          ports: ["22", "3389"],
        }),
      );
      expect(updated.rule.ruleId).toEqual(rule.ruleId);
      expect(updated.collection.ruleCollectionId).toEqual(
        collection.ruleCollectionId,
      );
      const reobservedRule = yield* getRule(
        group.resourceGroupName,
        manager.networkManagerName,
        configuration.configurationName,
        collection.ruleCollectionName,
        rule.ruleName,
      );
      expect(reobservedRule.properties?.access).toEqual("AlwaysAllow");
      expect(reobservedRule.properties?.destinationPortRanges).toEqual([
        "22",
        "3389",
      ]);
      const observedCollection = yield* getCollection(
        group.resourceGroupName,
        manager.networkManagerName,
        configuration.configurationName,
        collection.ruleCollectionName,
      );
      expect(observedCollection.properties?.description).toEqual("two");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getCollection(
            group.resourceGroupName,
            manager.networkManagerName,
            configuration.configurationName,
            collection.ruleCollectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withNetworkManager, logLevel),
  { tags, timeout: 600_000 },
);
