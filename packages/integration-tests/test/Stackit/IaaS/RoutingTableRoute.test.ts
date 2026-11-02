import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Routing tables are a preview feature of network areas: run with
// STACKIT_TEST_ROUTING_TABLES=1 once the organization has access to it.
const hasRoutingTables = !!process.env.STACKIT_TEST_ROUTING_TABLES;
const options = { tags: stackitTags("iaas", "routingtableroute"), timeout: 600_000 } as const;

interface RouteRef {
  organizationId: string;
  areaId: string;
  region: string;
  routingTableId: string;
  routeId: string;
}

const observe = (ref: RouteRef) =>
  iaas
    .getRouteOfRoutingTable(ref)
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (ref: RouteRef) =>
  observe(ref).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (route) => route === "gone",
      times: 10,
    }),
    Effect.map((route) => expect(route).toEqual("gone")),
  );

const withRoute = (
  route: Pick<Stackit.IaaS.RoutingTableRouteProps, "destination" | "nexthop" | "labels">,
) =>
  Effect.gen(function* () {
    const area = yield* Stackit.IaaS.NetworkArea("RtRouteArea", { routingTables: true });
    const regional = yield* Stackit.IaaS.NetworkAreaRegion("RtRouteRegion", {
      networkAreaId: area.networkAreaId,
      networkRanges: ["10.240.0.0/16"],
      transferNetwork: "10.241.255.0/24",
    });
    const table = yield* Stackit.IaaS.RoutingTable("RtRouteTable", {
      networkAreaId: regional.networkAreaId,
      systemRoutes: false,
    });
    const created = yield* Stackit.IaaS.RoutingTableRoute("Default", {
      networkAreaId: table.networkAreaId,
      routingTableId: table.routingTableId,
      ...route,
    });
    return { area, table, route: created };
  });

test.provider.skipIf(!hasRoutingTables)(
  "create, relabel, replace and delete a routing table route",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      const organizationId = env.organizationId ?? "";
      expect(organizationId).not.toEqual("");
      yield* stack.destroy();

      const created = yield* stack.deploy(
        withRoute({
          destination: { type: "cidrv4", value: "0.0.0.0/0" },
          nexthop: { type: "ipv4", value: "10.240.0.5" },
          labels: { env: "test" },
        }),
      );
      const ref = (routeId: string): RouteRef => ({
        organizationId,
        areaId: created.area.networkAreaId,
        region: env.region,
        routingTableId: created.table.routingTableId,
        routeId,
      });
      expect(created.route.routeId).toEqual(expect.any(String));
      expect(created.route.nexthop).toEqual({ type: "ipv4", value: "10.240.0.5" });

      const fetched = yield* iaas.getRouteOfRoutingTable(ref(created.route.routeId));
      expect(fetched.destination).toEqual({ type: "cidrv4", value: "0.0.0.0/0" });
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        "alchemy.id": "Default",
      });

      const relabeled = yield* stack.deploy(
        withRoute({
          destination: { type: "cidrv4", value: "0.0.0.0/0" },
          nexthop: { type: "ipv4", value: "10.240.0.5" },
          labels: { env: "prod" },
        }),
      );
      expect(relabeled.route.routeId).toEqual(created.route.routeId);
      const refetched = yield* iaas.getRouteOfRoutingTable(ref(created.route.routeId));
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      const replaced = yield* stack.deploy(
        withRoute({
          destination: { type: "cidrv4", value: "0.0.0.0/0" },
          nexthop: { type: "internet" },
          labels: { env: "prod" },
        }),
      );
      expect(replaced.route.routeId).not.toEqual(created.route.routeId);
      expect(replaced.route.nexthop).toEqual({ type: "internet" });
      yield* expectGone(ref(created.route.routeId));

      yield* stack.destroy();
      yield* expectGone(ref(replaced.route.routeId));
    }).pipe(logLevel),
  options,
);
