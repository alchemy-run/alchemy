import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getFilter = (resourceGroupName: string, routeFilterName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetRouteFilter({
      subscriptionId,
      resourceGroupName,
      routeFilterName,
    }),
  );

// Route filters are free.
const program = (env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const filter = yield* Azure.Network.RouteFilter("Filter", {
      resourceGroup: group.resourceGroupName,
      tags: { env },
    });
    return { group, filter };
  });

test.provider(
  "create, update, and delete a route filter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, filter } = yield* stack.deploy(program("test"));
      const observed = yield* getFilter(
        group.resourceGroupName,
        filter.routeFilterName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program("prod"));
      expect(updated.filter.routeFilterId).toEqual(filter.routeFilterId);
      expect(
        (yield* getFilter(group.resourceGroupName, filter.routeFilterName)).tags
          ?.env,
      ).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getFilter(group.resourceGroupName, filter.routeFilterName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
