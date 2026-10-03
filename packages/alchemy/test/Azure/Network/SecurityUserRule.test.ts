import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import { runPaidOnly } from "../gates.ts";
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
    network.GetSecurityUserRule({
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
    network.GetSecurityUserConfiguration({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      configurationName,
    }),
  );

// Undeployed security user configurations are free, but the feature is a
// preview the trial subscription is not registered for
// (AllowAVNMPreviewJuly2022): the lifecycle runs only with AZURE_TEST_PAID=1.
const program = (props: { description: string; ports: string[] }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const manager = yield* Azure.Network.NetworkManager("Manager", {
      resourceGroup: group.resourceGroupName,
      scopeAccesses: ["SecurityUser"],
    });
    const networkGroup = yield* Azure.Network.NetworkGroup("App", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
    });
    const configuration = yield* Azure.Network.SecurityUserConfiguration(
      "Users",
      {
        resourceGroup: group.resourceGroupName,
        networkManager: manager.networkManagerName,
        description: props.description,
      },
    );
    const collection = yield* Azure.Network.SecurityUserRuleCollection(
      "Rules",
      {
        resourceGroup: group.resourceGroupName,
        networkManager: manager.networkManagerName,
        securityUserConfiguration: configuration.configurationName,
        description: props.description,
        networkGroupIds: [networkGroup.networkGroupId],
      },
    );
    const rule = yield* Azure.Network.SecurityUserRule("Https", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      securityUserConfiguration: configuration.configurationName,
      ruleCollection: collection.ruleCollectionName,
      description: props.description,
      protocol: "Tcp",
      direction: "Inbound",
      destinationPortRanges: props.ports,
    });
    return { group, manager, configuration, collection, rule };
  });

test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a security user configuration, collection, and rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, configuration, collection, rule } =
        yield* stack.deploy(program({ description: "one", ports: ["443"] }));
      expect(collection.networkGroupIds.length).toEqual(1);
      expect(rule.direction).toEqual("Inbound");
      const observed = yield* getRule(
        group.resourceGroupName,
        manager.networkManagerName,
        configuration.configurationName,
        collection.ruleCollectionName,
        rule.ruleName,
      );
      expect(observed.properties?.destinationPortRanges).toEqual(["443"]);

      const updated = yield* stack.deploy(
        program({ description: "two", ports: ["443", "8443"] }),
      );
      expect(updated.rule.ruleId).toEqual(rule.ruleId);
      const reobserved = yield* getRule(
        group.resourceGroupName,
        manager.networkManagerName,
        configuration.configurationName,
        collection.ruleCollectionName,
        rule.ruleName,
      );
      expect(reobserved.properties?.destinationPortRanges).toEqual([
        "443",
        "8443",
      ]);
      expect(reobserved.properties?.description).toEqual("two");
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

test.provider(
  "security user scope access is rejected with a typed preview-feature error on the trial",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sub = yield* subscriptionId;
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("ProbeGroup", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* network
        .NetworkManagersCreateOrUpdate({
          subscriptionId: sub,
          resourceGroupName: group.resourceGroupName,
          networkManagerName: "security-user-probe",
          location: "eastus",
          properties: {
            networkManagerScopes: { subscriptions: [`/subscriptions/${sub}`] },
            networkManagerScopeAccesses: ["SecurityUser"],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SubscriptionFeatureNotRegistered");
      yield* stack.destroy();
    }).pipe(withNetworkManager, logLevel),
  { tags, timeout: 600_000 },
);
