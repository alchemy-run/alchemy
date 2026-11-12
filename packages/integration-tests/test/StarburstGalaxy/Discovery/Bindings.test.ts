import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { deployWarehouse } from "../fixtures/bindings-warehouse.ts";
import { cloudflareSkipReason, WAREHOUSES } from "../fixtures/bindings.ts";
import GalaxyDiscoveryWorker from "../fixtures/discovery-worker.ts";
import { getJson } from "../fixtures/http.ts";
import { SALES } from "../fixtures/warehouse.ts";
import { freshStack } from "../helpers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers(), Cloudflare.providers()),
});

const named = (title: string) =>
  cloudflareSkipReason ? `${title} [skipped: ${cloudflareSkipReason}]` : title;

test.provider.skipIf(!!cloudflareSkipReason)(
  named("a Worker lists, reads and documents the warehouse through the Discovery bindings"),
  (stack) =>
    Effect.gen(function* () {
      // The warehouse in its own stack, destroyed after this one: the Worker binds it through a lookup.
      const catalog = yield* deployWarehouse(WAREHOUSES.discovery);
      yield* freshStack(stack);
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* GalaxyDiscoveryWorker;
          return { url: worker.url.as<string>() };
        }),
      );

      const read = yield* getJson<{
        catalogId: string;
        catalogName: string;
        schemas: string[];
        schema: string;
        tables: string[];
        tableType: string;
        columns: string[];
        amountType: string;
      }>(url, "/catalog");
      expect(read.catalogId).toBe(catalog.catalogId);
      expect(read.catalogName).toBe(WAREHOUSES.discovery);
      expect(read.schemas).toContain(SALES.schemaName);
      expect(read.schema).toBe(SALES.schemaName);
      expect(read.tables).toEqual([SALES.tableName]);
      expect(read.tableType).toBe("BASE TABLE");
      expect([...read.columns].sort()).toEqual(["amount", "customer", "id", "placed_at"]);
      expect(read.amountType).toBe("decimal(10,2)");

      // The write binding documents a column; Galaxy reports it back.
      const written = yield* getJson<{ description: string }>(url, "/describe?text=Who%20paid");
      expect(written.description).toBe("Who paid");
      const column = yield* galaxy.discovery.getCatalogSchemaTableColumn({
        catalogId: catalog.catalogId,
        schemaId: SALES.schemaName,
        tableId: SALES.tableName,
        columnId: "customer",
      });
      expect(column.description).toBe("Who paid");

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:discovery",
      "provider:neon",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 900_000,
  },
);
