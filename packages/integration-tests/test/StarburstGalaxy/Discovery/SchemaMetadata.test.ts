import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SALES, Warehouse } from "../fixtures/warehouse.ts";
import { freshStack } from "../helpers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()),
});

test.provider(
  "describe a schema with a link, change it, and clear it on removal",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const app = (props: Partial<StarburstGalaxy.Discovery.SchemaMetadataProps> | undefined) =>
        Effect.gen(function* () {
          const catalog = yield* Warehouse;
          const metadata =
            props === undefined
              ? undefined
              : yield* StarburstGalaxy.Discovery.SchemaMetadata("SalesDocs", {
                  catalogId: catalog.catalogId,
                  schemaName: SALES.schemaName,
                  ...props,
                });
          return { catalog, metadata };
        });

      const set = yield* stack.deploy(
        app({
          description: "Orders, loaded hourly",
          links: [{ name: "Runbook", uri: "https://example.com/sales" }],
        }),
      );
      const ids = { catalogId: set.catalog.catalogId, schemaId: SALES.schemaName };
      const live = yield* galaxy.discovery.getCatalogSchema(ids);
      expect(live.description).toBe("Orders, loaded hourly");
      expect(live.links).toEqual([{ name: "Runbook", uri: "https://example.com/sales" }]);

      const changed = yield* stack.deploy(app({ description: "Orders and refunds" }));
      expect(changed.metadata?.description).toBe("Orders and refunds");
      const changedLive = yield* galaxy.discovery.getCatalogSchema(ids);
      expect(changedLive.description).toBe("Orders and refunds");
      expect(changedLive.links).toEqual([]);

      // Removing the resource clears the description and keeps the schema.
      yield* stack.deploy(app(undefined));
      const cleared = yield* galaxy.discovery.getCatalogSchema(ids);
      expect(cleared.description ?? "").toBe("");
      expect(cleared.schemaId).toBe(SALES.schemaName);

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:discovery",
      "provider:neon",
      "live",
    ],
    timeout: 600_000,
  },
);
