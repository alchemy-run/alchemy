import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { getCatalog, gone, logLevel, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const catalog = yield* Azure.AzureSphere.Catalog("Catalog", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, catalog };
  });

// Azure Sphere catalogs are free; about 2 minutes.
test.provider(
  "create, update, replace, and delete an azure sphere catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, catalog } = yield* stack.deploy(program({ tags: { env: "v1" } }));
      const rg = group.resourceGroupName;
      expect(catalog.catalogName).toMatch(/^[A-Za-z0-9_-]{1,29}$/);
      expect(catalog.location).toEqual("global");
      expect(catalog.tags).toEqual({ env: "v1" });
      expect(catalog.catalogId.toLowerCase()).toContain(
        `/providers/microsoft.azuresphere/catalogs/${catalog.catalogName.toLowerCase()}`,
      );
      const observed = yield* getCatalog(rg, catalog.catalogName);
      expect(observed.tags?.env).toEqual("v1");
      expect(observed.tags?.["alchemy::id"]).toEqual("Catalog");

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "v2" } }));
      expect(updated.catalog.catalogName).toEqual(catalog.catalogName);
      expect(updated.catalog.tags).toEqual({ env: "v2" });
      const reobserved = yield* getCatalog(rg, catalog.catalogName);
      expect(reobserved.tags?.env).toEqual("v2");

      // Replacement: the name is the catalog's identity.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-sphere-catalog-test", tags: { env: "v2" } }),
      );
      expect(replaced.catalog.catalogName).toEqual("alchemy-sphere-catalog-test");
      const renamed = yield* getCatalog(rg, "alchemy-sphere-catalog-test");
      expect(renamed.name).toEqual("alchemy-sphere-catalog-test");
      expect(yield* gone(getCatalog(rg, catalog.catalogName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* gone(getCatalog(rg, "alchemy-sphere-catalog-test"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
