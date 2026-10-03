import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const where = (resourceGroupName: string, serviceName: string, sid: string) =>
  Effect.map(subscriptionId, (subscriptionId) => ({
    subscriptionId,
    resourceGroupName,
    serviceName,
    sid,
  }));

const getSubscription = (rg: string, svc: string, sid: string) =>
  Effect.flatMap(where(rg, svc, sid), apim.GetSubscription);

const getSecrets = (rg: string, svc: string, sid: string) =>
  Effect.flatMap(where(rg, svc, sid), apim.ListSubscriptionSecrets);

const program = (subscription?: {
  name: string;
  displayName: string;
  state: Azure.ApiManagement.SubscriptionState;
  allApis: boolean;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const product = yield* Azure.ApiManagement.Product("Starter", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-starter",
      state: "published",
    });
    const created = subscription
      ? yield* Azure.ApiManagement.Subscription("Client", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: subscription.name,
          displayName: subscription.displayName,
          state: subscription.state,
          scope: subscription.allApis ? "/apis" : product.productId,
        })
      : undefined;
    return { group, service, product, subscription: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete a subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({
          name: "alchemy-client",
          displayName: "Client",
          state: "active",
          allApis: false,
        }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.subscription?.subscriptionName).toEqual("alchemy-client");
      const observed = yield* getSubscription(rg, svc, "alchemy-client");
      expect(observed.properties?.state).toEqual("active");
      expect(observed.properties?.scope.toLowerCase()).toMatch(
        /\/products\/alchemy-starter$/,
      );
      const secrets = yield* getSecrets(rg, svc, "alchemy-client");
      expect(secrets.primaryKey).toBeDefined();
      expect(
        first.subscription?.primaryKey &&
          Redacted.value(first.subscription.primaryKey),
      ).toEqual(secrets.primaryKey);

      // In-place update: display name, state, and scope.
      yield* stack.deploy(
        program({
          name: "alchemy-client",
          displayName: "Client (suspended)",
          state: "suspended",
          allApis: true,
        }),
      );
      const updated = yield* getSubscription(rg, svc, "alchemy-client");
      expect(updated.properties?.displayName).toEqual("Client (suspended)");
      expect(updated.properties?.state).toEqual("suspended");
      expect(updated.properties?.scope.toLowerCase()).toMatch(/\/apis$/);

      // Replacement: a new identifier creates a new subscription.
      yield* stack.deploy(
        program({
          name: "alchemy-client-v2",
          displayName: "Client v2",
          state: "active",
          allApis: true,
        }),
      );
      expect(
        (yield* getSubscription(rg, svc, "alchemy-client-v2")).properties
          ?.state,
      ).toEqual("active");
      expect(
        yield* untilGone(getSubscription(rg, svc, "alchemy-client")),
      ).toEqual("gone");

      // Removing the subscription deletes it while the service stays.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getSubscription(rg, svc, "alchemy-client-v2")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
