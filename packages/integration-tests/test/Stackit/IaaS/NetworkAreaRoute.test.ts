import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Free; needs organization-level IaaS permissions for the test service
// account (and an organization id in the profile).
const options = { tags: stackitTags("iaas", "networkarearoute"), timeout: 600_000 } as const;

const observe = (organizationId: string, areaId: string, region: string, routeId: string) =>
  iaas
    .getNetworkAreaRoute({ organizationId, areaId, region, routeId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (organizationId: string, areaId: string, region: string, routeId: string) =>
  observe(organizationId, areaId, region, routeId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (route) => route === "gone",
      times: 10,
    }),
    Effect.map((route) => expect(route).toEqual("gone")),
  );

const withRoute = (
  route: Pick<Stackit.IaaS.NetworkAreaRouteProps, "destination" | "nexthop" | "labels">,
) =>
  Effect.gen(function* () {
    const area = yield* Stackit.IaaS.NetworkArea("RouteArea", {});
    const regional = yield* Stackit.IaaS.NetworkAreaRegion("RouteRegion", {
      networkAreaId: area.networkAreaId,
      networkRanges: ["10.236.0.0/16"],
      transferNetwork: "10.237.255.0/24",
    });
    const created = yield* Stackit.IaaS.NetworkAreaRoute("OnPrem", {
      networkAreaId: regional.networkAreaId,
      ...route,
    });
    return { area, route: created };
  });

test.provider(
  "create, relabel, replace and delete a network area route",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      const organizationId = env.organizationId ?? "";
      expect(organizationId).not.toEqual("");
      yield* stack.destroy();

      const created = yield* stack.deploy(
        withRoute({
          destination: { type: "cidrv4", value: "192.168.232.0/24" },
          nexthop: { type: "ipv4", value: "10.236.0.10" },
          labels: { env: "test" },
        }),
      );
      const areaId = created.area.networkAreaId;
      expect(created.route.routeId).toEqual(expect.any(String));
      expect(created.route.destination).toEqual({ type: "cidrv4", value: "192.168.232.0/24" });
      expect(created.route.nexthop).toEqual({ type: "ipv4", value: "10.236.0.10" });
      expect(created.route.labels).toEqual({ env: "test" });

      const fetched = yield* iaas.getNetworkAreaRoute({
        organizationId,
        areaId,
        region: env.region,
        routeId: created.route.routeId,
      });
      expect(fetched.destination).toEqual({ type: "cidrv4", value: "192.168.232.0/24" });
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({ "alchemy.id": "OnPrem" });

      const relabeled = yield* stack.deploy(
        withRoute({
          destination: { type: "cidrv4", value: "192.168.232.0/24" },
          nexthop: { type: "ipv4", value: "10.236.0.10" },
          labels: { env: "prod" },
        }),
      );
      expect(relabeled.route.routeId).toEqual(created.route.routeId);
      const refetched = yield* iaas.getNetworkAreaRoute({
        organizationId,
        areaId,
        region: env.region,
        routeId: created.route.routeId,
      });
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // A new next hop replaces the route.
      const replaced = yield* stack.deploy(
        withRoute({
          destination: { type: "cidrv4", value: "192.168.232.0/24" },
          nexthop: { type: "blackhole" },
          labels: { env: "prod" },
        }),
      );
      expect(replaced.route.routeId).not.toEqual(created.route.routeId);
      expect(replaced.route.nexthop).toEqual({ type: "blackhole" });
      yield* expectGone(organizationId, areaId, env.region, created.route.routeId);

      yield* stack.destroy();
      yield* expectGone(organizationId, areaId, env.region, replaced.route.routeId);
    }).pipe(logLevel),
  options,
);
