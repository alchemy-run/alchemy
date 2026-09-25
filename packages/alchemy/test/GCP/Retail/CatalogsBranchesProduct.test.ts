import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as retail from "@distilled.cloud/gcp/retail_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

// Retail create returns Forbidden: "AI Commerce Search API has not been
// used in project … or it is disabled."
const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_RETAIL === "1";

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  retail.getProjectsLocationsCatalogsBranchesProducts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCatalogsBranchesProducts on a missing product fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        retail.getProjectsLocationsCatalogsBranchesProducts({
          name: `projects/${project}/locations/global/catalogs/default_catalog/branches/default_branch/products/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(
          "AI Commerce Search API has not been used",
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a catalog branch product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsBranchesProduct("Shirt", {
            title: "Cotton tee",
            categories: ["Apparel > T-Shirts"],
            description: "test tee",
            priceInfo: { currencyCode: "USD", price: 20 },
          });
        }),
      );

      expect(created.name).toContain("/products/");
      expect(created.title).toEqual("Cotton tee");
      expect(created.categories).toEqual(
        expect.arrayContaining(["Apparel > T-Shirts"]),
      );
      expect(created.description).toEqual("test tee");

      const fetched =
        yield* retail.getProjectsLocationsCatalogsBranchesProducts({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toMatch(/\[alchemy /);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsBranchesProduct("Shirt", {
            productId: created.productId,
            catalog: created.catalog,
            branchId: created.branchId,
            title: "Linen tee",
            categories: ["Apparel > T-Shirts"],
            description: "updated tee",
            priceInfo: { currencyCode: "USD", price: 24 },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.title).toEqual("Linen tee");
      expect(updated.priceInfo?.price).toEqual(24);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
