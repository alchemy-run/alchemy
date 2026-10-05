import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRoute = (
  resourceGroupName: string,
  routeTableName: string,
  routeName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetRoute({
      subscriptionId,
      resourceGroupName,
      routeTableName,
      routeName,
    }),
  );

// Route tables and routes are free.
const program = (props: {
  name?: string;
  nextHopType: Azure.Network.RouteNextHopType;
  nextHopIpAddress?: string;
  disableBgpRoutePropagation?: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const table = yield* Azure.Network.RouteTable("Egress", {
      resourceGroup: group.resourceGroupName,
      disableBgpRoutePropagation: props.disableBgpRoutePropagation,
    });
    const route = yield* Azure.Network.Route("Default", {
      resourceGroup: group.resourceGroupName,
      routeTable: table.routeTableName,
      name: props.name,
      addressPrefix: "0.0.0.0/0",
      nextHopType: props.nextHopType,
      nextHopIpAddress: props.nextHopIpAddress,
    });
    const drop = yield* Azure.Network.Route("Drop", {
      resourceGroup: group.resourceGroupName,
      routeTable: table.routeTableName,
      addressPrefix: "192.168.0.0/16",
      nextHopType: "None",
    });
    return { group, table, route, drop };
  });

test.provider(
  "create, update, replace, and delete a route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, table, route, drop } = yield* stack.deploy(
        program({ nextHopType: "Internet" }),
      );
      expect(route.nextHopType).toEqual("Internet");
      const observed = yield* getRoute(
        group.resourceGroupName,
        table.routeTableName,
        route.routeName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.addressPrefix).toEqual("0.0.0.0/0");
      expect(observed.properties?.nextHopType).toEqual("Internet");

      // In-place update of the route, plus a parent update that must keep
      // both routes.
      const updated = yield* stack.deploy(
        program({
          nextHopType: "VirtualAppliance",
          nextHopIpAddress: "10.0.0.4",
          disableBgpRoutePropagation: true,
        }),
      );
      expect(updated.route.routeId).toEqual(route.routeId);
      const reobserved = yield* getRoute(
        group.resourceGroupName,
        table.routeTableName,
        route.routeName,
      );
      expect(reobserved.properties?.nextHopType).toEqual("VirtualAppliance");
      expect(reobserved.properties?.nextHopIpAddress).toEqual("10.0.0.4");
      const parent = yield* Effect.flatMap(subscriptionId, (subscriptionId) =>
        network.GetRouteTable({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          routeTableName: table.routeTableName,
        }),
      );
      expect(parent.properties?.disableBgpRoutePropagation).toEqual(true);
      expect(
        (parent.properties?.routes ?? []).map((r) => r.name).sort(),
      ).toEqual([route.routeName, drop.routeName].sort());

      // Renaming replaces the route.
      const renamed = yield* stack.deploy(
        program({
          name: "default-route",
          nextHopType: "VirtualAppliance",
          nextHopIpAddress: "10.0.0.4",
          disableBgpRoutePropagation: true,
        }),
      );
      expect(renamed.route.routeName).toEqual("default-route");
      expect(
        (yield* getRoute(
          group.resourceGroupName,
          table.routeTableName,
          "default-route",
        )).properties?.nextHopIpAddress,
      ).toEqual("10.0.0.4");
      expect(
        yield* untilGone(
          getRoute(
            group.resourceGroupName,
            table.routeTableName,
            route.routeName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRoute(
            group.resourceGroupName,
            table.routeTableName,
            "default-route",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
