import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRouteTable = (resourceGroupName: string, routeTableName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetRouteTable({
      subscriptionId,
      resourceGroupName,
      routeTableName,
    }),
  );

const program = (props: {
  disableBgpRoutePropagation: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const routes = yield* Azure.Network.RouteTable("Egress", {
      resourceGroup: group.resourceGroupName,
      disableBgpRoutePropagation: props.disableBgpRoutePropagation,
      tags: props.tags,
    });
    return { group, routes };
  });

test.provider(
  "create, update, and delete a route table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, routes } = yield* stack.deploy(
        program({ disableBgpRoutePropagation: false, tags: { env: "test" } }),
      );
      expect(routes.disableBgpRoutePropagation).toEqual(false);
      const observed = yield* getRouteTable(
        group.resourceGroupName,
        routes.routeTableName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.disableBgpRoutePropagation).toEqual(false);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ disableBgpRoutePropagation: true, tags: { env: "prod" } }),
      );
      expect(updated.routes.routeTableId).toEqual(routes.routeTableId);
      const reobserved = yield* getRouteTable(
        group.resourceGroupName,
        routes.routeTableName,
      );
      expect(reobserved.properties?.disableBgpRoutePropagation).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRouteTable(group.resourceGroupName, routes.routeTableName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
