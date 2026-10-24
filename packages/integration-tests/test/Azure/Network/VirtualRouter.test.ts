import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { routeServer } from "./gatewayFixtures.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRouter = (resourceGroupName: string, virtualRouterName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualRouter({ subscriptionId, resourceGroupName, virtualRouterName }),
  );

// ~$0.50/run, 30-45 min: a router bills ~$0.45/hour and takes ~20 minutes
// to create and ~10 minutes to delete.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a virtual router",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, subnet, router } = yield* stack.deploy(routeServer("test"));
      expect(router.virtualRouterAsn).toEqual(65515);
      expect(router.hostedSubnetId?.toLowerCase()).toEqual(subnet.subnetId.toLowerCase());
      const observed = yield* getRouter(group.resourceGroupName, router.virtualRouterName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(routeServer("prod"));
      expect(updated.router.virtualRouterId).toEqual(router.virtualRouterId);
      const reobserved = yield* getRouter(group.resourceGroupName, router.virtualRouterName);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getRouter(group.resourceGroupName, router.virtualRouterName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
