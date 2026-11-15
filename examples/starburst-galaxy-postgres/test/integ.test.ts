import { expect } from "bun:test";
import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Test from "@alchemy.run/test/Bun";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

// Read Galaxy as the deploying profile's API client.
const galaxyApi = StarburstGalaxy.fromAuthProvider().pipe(
  Layer.provideMerge(StarburstGalaxy.StarburstGalaxyAuth),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "Galaxy reads the shop schema through the catalog",
  Effect.gen(function* () {
    const { catalogId } = yield* stack;
    // A new catalog's tables can take a few seconds to appear.
    const tables = yield* Stream.runCollect(
      galaxy.discovery.listCatalogSchemaTables.items({ catalogId, schemaId: "shop" }),
    ).pipe(
      Effect.flatMap((items) =>
        items.length > 0 ? Effect.succeed(items) : Effect.fail("no tables yet" as const),
      ),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
    );
    expect(tables.map((table) => table.tableId)).toEqual(["orders"]);
  }).pipe(Effect.provide(galaxyApi)),
  { timeout: 120_000 },
);

test(
  "the reporting login holds the reporting role and may use the cluster",
  Effect.gen(function* () {
    const { roleId, clusterId, userName } = yield* stack;
    const privileges = yield* Stream.runCollect(
      galaxy.privilege.listRolePrivileges.items({ roleId }),
    );
    expect(privileges.some((p) => p.privilege === "UseCluster" && p.entityId === clusterId)).toBe(
      true,
    );
    expect(userName).toContain("@");
  }).pipe(Effect.provide(galaxyApi)),
  { timeout: 60_000 },
);
