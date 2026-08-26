import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const project = process.env.GOOGLE_PROJECT_ID ?? "";

export const catalogParent = `projects/${project}/locations/global`;

export const defaultCatalog = `${catalogParent}/catalogs/default_catalog`;

export const missingName = `${defaultCatalog}/catalogItems/alchemy-missing`;

export const entitlementTags = ["Forbidden", "NotFound"] as const;

/**
 * `NotFound` on a missing item means the Recommendations AI API is
 * reachable. `Forbidden` is the entitlement rejection (`get` does not
 * type `BadRequest`).
 */
export const probeCatalogAccess = recommendationengine
  .getProjectsLocationsCatalogsCatalogItems({ name: missingName })
  .pipe(
    Effect.as("ok" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
    Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
  );
