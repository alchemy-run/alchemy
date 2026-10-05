import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMap = (
  resourceGroupName: string,
  virtualHubName: string,
  routeMapName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetRouteMap({
      subscriptionId,
      resourceGroupName,
      virtualHubName,
      routeMapName,
    }),
  );

const program = (prefix: string) =>
  Effect.gen(function* () {
    const { group, wan, hub } = yield* standardHub;
    const map = yield* Azure.Network.RouteMap("Filter", {
      resourceGroup: group.resourceGroupName,
      virtualHub: hub.virtualHubName,
      rules: [
        {
          name: "drop",
          matchCriteria: [{ matchCondition: "Contains", routePrefix: [prefix] }],
          actions: [{ type: "Drop" }],
          nextStepIfMatched: "Terminate",
        },
      ],
    });
    return { group, wan, hub, map };
  });

// Needs a Standard hub (~$0.25/hour, 15-30 min): ≈$0.30, ~40 min per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a route map",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub, map } = yield* stack.deploy(program("10.99.0.0/16"));
      const observed = yield* getMap(
        group.resourceGroupName,
        hub.virtualHubName,
        map.routeMapName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      const updated = yield* stack.deploy(program("10.98.0.0/16"));
      expect(updated.map.routeMapId).toEqual(map.routeMapId);
      const reobserved = yield* getMap(
        group.resourceGroupName,
        hub.virtualHubName,
        map.routeMapName,
      );
      expect(
        reobserved.properties?.rules?.[0]?.matchCriteria?.[0]?.routePrefix,
      ).toEqual(["10.98.0.0/16"]);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getMap(group.resourceGroupName, hub.virtualHubName, map.routeMapName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
