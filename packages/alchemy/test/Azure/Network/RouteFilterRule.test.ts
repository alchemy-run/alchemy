import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  routeFilterName: string,
  ruleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetRouteFilterRule({
      subscriptionId,
      resourceGroupName,
      routeFilterName,
      ruleName,
    }),
  );
const getFilter = (resourceGroupName: string, routeFilterName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetRouteFilter({
      subscriptionId,
      resourceGroupName,
      routeFilterName,
    }),
  );

// Route filters and their rules are free.
const program = (communities: string[], env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const filter = yield* Azure.Network.RouteFilter("Filter", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      tags: { env },
    });
    const rule = yield* Azure.Network.RouteFilterRule("Rule", {
      resourceGroup: group.resourceGroupName,
      routeFilter: filter.routeFilterName,
      communities,
    });
    return { group, filter, rule };
  });

test.provider(
  "create, update, and delete a route filter and its rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, filter, rule } = yield* stack.deploy(
        program(["12076:51004"], "test"),
      );
      expect(rule.communities).toEqual(["12076:51004"]);
      const observed = yield* getRule(
        group.resourceGroupName,
        filter.routeFilterName,
        rule.ruleName,
      );
      expect(observed.properties?.access).toEqual("Allow");

      // A tag update on the filter PUT must keep the rule.
      const updated = yield* stack.deploy(
        program(["12076:51004", "12076:51005"], "prod"),
      );
      expect(updated.rule.ruleId).toEqual(rule.ruleId);
      const reobserved = yield* getRule(
        group.resourceGroupName,
        filter.routeFilterName,
        rule.ruleName,
      );
      expect([...(reobserved.properties?.communities ?? [])].sort()).toEqual([
        "12076:51004",
        "12076:51005",
      ]);
      const observedFilter = yield* getFilter(
        group.resourceGroupName,
        filter.routeFilterName,
      );
      expect(observedFilter.tags?.env).toEqual("prod");
      expect(observedFilter.properties?.rules?.length).toEqual(1);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getFilter(group.resourceGroupName, filter.routeFilterName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
