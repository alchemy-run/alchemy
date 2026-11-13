import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { freshStack, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const examplesOf = (dataProductId: string) =>
  galaxy.dataProductUsageExample.listDataProductUsageExamples.items({ dataProductId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

test.provider(
  "add an example query to a data product, edit it, and remove it",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const app = (
        example?: Omit<StarburstGalaxy.DataProduct.DataProductUsageExampleProps, "dataProductId">,
      ) =>
        Effect.gen(function* () {
          const catalog = yield* StarburstGalaxy.Catalog.PostgresqlCatalog("Shop", {
            endpoint: UNVALIDATED_ENDPOINT,
            databaseName: "shop",
            username: "galaxy",
            password: secret("shop"),
            validate: false,
          });
          const product = yield* StarburstGalaxy.DataProduct.DataProduct("Orders", {
            summary: "Every order",
            catalogId: catalog.catalogId,
            schemaName: "orders",
          });
          const usage =
            example === undefined
              ? undefined
              : yield* StarburstGalaxy.DataProduct.DataProductUsageExample("TopCustomers", {
                  dataProductId: product.dataProductId,
                  ...example,
                });
          return { product, usage };
        });

      const created = yield* stack.deploy(
        app({ code: "SELECT customer FROM orders LIMIT 10", suggestedPrompt: "Who buys?" }),
      );
      const dataProductId = created.product.dataProductId;
      const [live] = yield* examplesOf(dataProductId);
      expect(live?.usageExampleId).toBe(created.usage?.usageExampleId);
      expect(live?.code).toBe("SELECT customer FROM orders LIMIT 10");
      expect(live?.suggestedPrompt).toBe("Who buys?");

      const edited = yield* stack.deploy(
        app({
          name: "Top customers",
          code: "SELECT customer, count(*) FROM orders GROUP BY 1",
          description: "Customers by order count",
        }),
      );
      expect(edited.usage?.usageExampleId).toBe(created.usage?.usageExampleId);
      const [editedLive] = yield* examplesOf(dataProductId);
      expect(editedLive?.name).toBe("Top customers");
      expect(editedLive?.code).toBe("SELECT customer, count(*) FROM orders GROUP BY 1");
      expect(editedLive?.description).toBe("Customers by order count");

      // Removing the example leaves the product.
      yield* stack.deploy(app());
      expect(yield* examplesOf(dataProductId)).toEqual([]);

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:data-product", "live"],
    timeout: 480_000,
  },
);
