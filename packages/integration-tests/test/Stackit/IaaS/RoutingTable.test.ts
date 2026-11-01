import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Routing tables are a preview feature of network areas: run with
// STACKIT_TEST_ROUTING_TABLES=1 once the organization has access to it.
// Free; needs organization-level IaaS permissions.
const hasRoutingTables = !!process.env.STACKIT_TEST_ROUTING_TABLES;
const options = { tags: stackitTags("iaas", "routingtable"), timeout: 600_000 } as const;

const observe = (organizationId: string, areaId: string, region: string, routingTableId: string) =>
  iaas
    .getRoutingTableOfArea({ organizationId, areaId, region, routingTableId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (
  organizationId: string,
  areaId: string,
  region: string,
  routingTableId: string,
) =>
  observe(organizationId, areaId, region, routingTableId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (table) => table === "gone",
      times: 10,
    }),
    Effect.map((table) => expect(table).toEqual("gone")),
  );

const withTable = (
  table: Omit<Stackit.IaaS.RoutingTableProps, "networkAreaId" | "organizationId" | "region">,
) =>
  Effect.gen(function* () {
    const area = yield* Stackit.IaaS.NetworkArea("TableArea", { routingTables: true });
    const regional = yield* Stackit.IaaS.NetworkAreaRegion("TableRegion", {
      networkAreaId: area.networkAreaId,
      networkRanges: ["10.238.0.0/16"],
      transferNetwork: "10.239.255.0/24",
    });
    const created = yield* Stackit.IaaS.RoutingTable("Isolated", {
      networkAreaId: regional.networkAreaId,
      ...table,
    });
    return { area, table: created };
  });

test.provider.skipIf(!hasRoutingTables)(
  "create, update and delete a routing table",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      const organizationId = env.organizationId ?? "";
      expect(organizationId).not.toEqual("");
      yield* stack.destroy();

      const created = yield* stack.deploy(
        withTable({ description: "isolated workloads", labels: { env: "test" } }),
      );
      const areaId = created.area.networkAreaId;
      expect(created.table.routingTableId).toEqual(expect.any(String));
      expect(created.table.default).toEqual(false);
      expect(created.table.systemRoutes).toEqual(true);
      expect(created.table.dynamicRoutes).toEqual(true);

      const fetched = yield* iaas.getRoutingTableOfArea({
        organizationId,
        areaId,
        region: env.region,
        routingTableId: created.table.routingTableId,
      });
      expect(fetched.description).toEqual("isolated workloads");
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        "alchemy.id": "Isolated",
      });

      const updated = yield* stack.deploy(
        withTable({
          name: "alchemy-iaas-rt-renamed",
          description: "no system routes",
          systemRoutes: false,
          dynamicRoutes: false,
          labels: { env: "prod" },
        }),
      );
      expect(updated.table.routingTableId).toEqual(created.table.routingTableId);
      const refetched = yield* iaas.getRoutingTableOfArea({
        organizationId,
        areaId,
        region: env.region,
        routingTableId: created.table.routingTableId,
      });
      expect(refetched.name).toEqual("alchemy-iaas-rt-renamed");
      expect(refetched.description).toEqual("no system routes");
      expect(refetched.systemRoutes).toEqual(false);
      expect(refetched.dynamicRoutes).toEqual(false);
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      yield* stack.destroy();
      yield* expectGone(organizationId, areaId, env.region, created.table.routingTableId);
    }).pipe(logLevel),
  options,
);
