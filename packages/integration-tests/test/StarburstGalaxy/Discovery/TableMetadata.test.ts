import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { SALES, Warehouse } from "../fixtures/warehouse.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()),
});

test.provider(
  "describe a table and its columns, change them, and clear them on removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (props: Partial<StarburstGalaxy.TableMetadataProps> | undefined) =>
        Effect.gen(function* () {
          const catalog = yield* Warehouse;
          const metadata =
            props === undefined
              ? undefined
              : yield* StarburstGalaxy.TableMetadata("OrdersDocs", {
                  catalogId: catalog.catalogId,
                  ...SALES,
                  ...props,
                });
          return { catalog, metadata };
        });

      const describe = (catalogId: string) =>
        Effect.gen(function* () {
          const ids = { catalogId, schemaId: SALES.schemaName, tableId: SALES.tableName };
          const table = yield* galaxy.discovery.getCatalogSchemaTable(ids);
          const columns = yield* galaxy.discovery.listCatalogSchemaTableColumns
            .items(ids)
            .pipe(Stream.runCollect);
          return {
            description: table.description ?? "",
            columns: Object.fromEntries(
              Array.from(columns, (column) => [column.columnId, column.description ?? ""]),
            ),
          };
        });

      const set = yield* stack.deploy(
        app({
          description: "One row per order",
          columnDescriptions: { amount: "Total in USD", customer: "Who paid" },
        }),
      );
      expect(set.metadata?.columns.map((column) => column.name).sort()).toEqual([
        "amount",
        "customer",
        "id",
        "placed_at",
      ]);
      expect(yield* describe(set.catalog.catalogId)).toEqual({
        description: "One row per order",
        columns: { amount: "Total in USD", customer: "Who paid", id: "", placed_at: "" },
      });

      // A changed description is sent; a dropped column description is cleared.
      yield* stack.deploy(
        app({
          description: "One row per order",
          columnDescriptions: { amount: "Total, tax included" },
        }),
      );
      expect(yield* describe(set.catalog.catalogId)).toEqual({
        description: "One row per order",
        columns: { amount: "Total, tax included", customer: "", id: "", placed_at: "" },
      });

      // Removing the resource clears what it set and keeps the table.
      yield* stack.deploy(app(undefined));
      expect(yield* describe(set.catalog.catalogId)).toEqual({
        description: "",
        columns: { amount: "", customer: "", id: "", placed_at: "" },
      });

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:discovery",
      "provider:neon",
      "live",
    ],
    timeout: 300_000,
  },
);
