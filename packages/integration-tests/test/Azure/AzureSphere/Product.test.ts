import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { catalogProgram, getProduct, gone, logLevel, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name?: string; description: string }) =>
  Effect.gen(function* () {
    const { group, catalog } = yield* catalogProgram;
    const product = yield* Azure.AzureSphere.Product("Product", {
      resourceGroup: group.resourceGroupName,
      catalog: catalog.catalogName,
      name: props.name,
      description: props.description,
    });
    return { group, catalog, product };
  });

// Azure Sphere catalogs and products are free; about 2 minutes.
test.provider(
  "create, update, replace, and delete an azure sphere product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, catalog, product } = yield* stack.deploy(program({ description: "v1" }));
      const rg = group.resourceGroupName;
      const cat = catalog.catalogName;
      expect(product.productName).toMatch(/^[A-Za-z0-9]{3,50}$/);
      expect(product.description).toEqual("v1");
      const observed = yield* getProduct(rg, cat, product.productName);
      expect(observed.properties?.description).toMatch(/^v1 \[alchemy [0-9a-f]{12}\]$/);

      // In place: description.
      const updated = yield* stack.deploy(program({ description: "v2" }));
      expect(updated.product.productName).toEqual(product.productName);
      expect(updated.product.description).toEqual("v2");
      const reobserved = yield* getProduct(rg, cat, product.productName);
      expect(reobserved.properties?.description).toMatch(/^v2 \[alchemy /);

      // Replacement: the name is the product's identity.
      const replaced = yield* stack.deploy(
        program({ name: "AlchemySphereProduct", description: "v2" }),
      );
      expect(replaced.product.productName).toEqual("AlchemySphereProduct");
      const renamed = yield* getProduct(rg, cat, "AlchemySphereProduct");
      expect(renamed.properties?.description).toMatch(/^v2 \[alchemy /);
      expect(yield* gone(getProduct(rg, cat, product.productName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* gone(getProduct(rg, cat, "AlchemySphereProduct"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
