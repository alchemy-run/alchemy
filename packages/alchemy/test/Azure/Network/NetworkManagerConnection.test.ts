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

const getConnection = (
  resourceGroupName: string,
  networkManagerName: string,
  scopeConnectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetScopeConnection({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      scopeConnectionName,
    }),
  );
const getNmConnection = (networkManagerConnectionName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetSubscriptionNetworkManagerConnection({
      subscriptionId,
      networkManagerConnectionName,
    }),
  );

// Scope and network manager connections are free. The test pairs both
// halves inside one tenant and subscription.
const program = (description: string) =>
  Effect.gen(function* () {
    const { subscriptionId: sub, tenantId } =
      yield* Azure.AzureEnvironment.current;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const manager = yield* Azure.Network.NetworkManager("Manager", {
      resourceGroup: group.resourceGroupName,
      scopeAccesses: [],
    });
    const scope = yield* Azure.Network.ScopeConnection("Scope", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      description,
      tenantId,
      resourceId: `/subscriptions/${sub}`,
    });
    const consent = yield* Azure.Network.NetworkManagerConnection("Consent", {
      networkManagerId: manager.networkManagerId,
      description,
    });
    return { group, manager, scope, consent };
  });

test.provider(
  "create, update, and delete a network manager connection (with a scope connection)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, scope, consent } = yield* stack.deploy(
        program("one"),
      );
      expect(scope.resourceId).toEqual(
        `/subscriptions/${yield* subscriptionId}`,
      );
      expect(consent.networkManagerId.toLowerCase()).toEqual(
        manager.networkManagerId.toLowerCase(),
      );
      expect(consent.description).toEqual("one");

      const updated = yield* stack.deploy(program("two"));
      expect(updated.scope.scopeConnectionId).toEqual(scope.scopeConnectionId);
      expect(
        (yield* getConnection(
          group.resourceGroupName,
          manager.networkManagerName,
          scope.scopeConnectionName,
        )).properties?.description,
      ).toEqual("two");
      expect(
        (yield* getNmConnection(consent.networkManagerConnectionName))
          .properties?.description,
      ).toContain("two");

      yield* stack.destroy();
      expect(
        yield* untilGone(getNmConnection(consent.networkManagerConnectionName)),
      ).toEqual("gone");
      expect(
        yield* untilGone(
          getConnection(
            group.resourceGroupName,
            manager.networkManagerName,
            scope.scopeConnectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withNetworkManager, logLevel),
  { tags, timeout: 600_000 },
);
