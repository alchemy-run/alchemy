import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import {
  catalogParent,
  defaultCatalog,
  entitlementTags,
  hasGcpCreds,
  logLevel,
  missingName,
  probeCatalogAccess,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  recommendationengine.getProjectsLocationsCatalogsCatalogItems({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const assertEntitlement = (error: { _tag: string; message: string }) => {
  expect([...entitlementTags, "BadRequest"]).toContain(error._tag);
  if (error._tag === "Forbidden") {
    expect(error.message).toContain(
      "Recommendations AI (Beta) has not been used",
    );
  }
};

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCatalogsCatalogItems on a missing item fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        recommendationengine.getProjectsLocationsCatalogsCatalogItems({
          name: missingName,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(
          "Recommendations AI (Beta) has not been used",
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createProjectsLocationsCatalogsCatalogItems is rejected with Forbidden when Recommendations AI is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* recommendationengine
        .createProjectsLocationsCatalogsCatalogItems({
          parent: defaultCatalog,
          body: {
            id: "alchemy-entitlement-probe",
            title: "alchemy-entitlement-probe",
            categoryHierarchies: [{ categories: ["Alchemy"] }],
          },
        })
        .pipe(Effect.result);

      if (Result.isSuccess(result)) {
        const id = result.success.id ?? "alchemy-entitlement-probe";
        yield* recommendationengine
          .deleteProjectsLocationsCatalogsCatalogItems({
            name: `${defaultCatalog}/catalogItems/${id}`,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      } else {
        assertEntitlement(result.failure);
      }

      const page = yield* recommendationengine
        .listProjectsLocationsCatalogs({
          parent: catalogParent,
          pageSize: 1,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ catalogs: [] }),
          ),
        );
      expect(Array.isArray(page.catalogs ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a catalog item",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeCatalogAccess;
      if (access !== "ok") {
        assertEntitlement(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Recommendationengine.CatalogsCatalogItem("Shirt", {
            title: "Cotton tee",
            description: "test tee",
            categoryHierarchies: [{ categories: ["Apparel", "T-Shirts"] }],
            productMetadata: {
              currencyCode: "USD",
              exactPrice: { displayPrice: 20 },
              stockState: "IN_STOCK",
            },
          });
        }),
      );

      expect(created.name).toContain("/catalogItems/");
      expect(created.title).toEqual("Cotton tee");
      expect(created.description).toEqual("test tee");
      expect(created.categoryHierarchies[0]?.categories).toEqual(
        expect.arrayContaining(["Apparel", "T-Shirts"]),
      );

      const fetched =
        yield* recommendationengine.getProjectsLocationsCatalogsCatalogItems({
          name: created.name,
        });
      expect(fetched.id).toEqual(created.catalogItemId);
      expect(fetched.description).toMatch(/\[alchemy /);
      expect(fetched.title).toEqual("Cotton tee");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Recommendationengine.CatalogsCatalogItem("Shirt", {
            catalogItemId: created.catalogItemId,
            catalog: created.catalog,
            location: created.location,
            title: "Linen tee",
            description: "updated tee",
            categoryHierarchies: [{ categories: ["Apparel", "T-Shirts"] }],
            productMetadata: {
              currencyCode: "USD",
              exactPrice: { displayPrice: 24 },
              stockState: "IN_STOCK",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.title).toEqual("Linen tee");
      expect(updated.productMetadata?.exactPrice?.displayPrice).toEqual(24);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
