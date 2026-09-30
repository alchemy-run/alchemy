import { GcpEnvironment } from "@/GCP/Environment";
import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const catalogParentOf = (project: string) =>
  `projects/${project}/locations/global`;

export const defaultCatalogOf = (project: string) =>
  `${catalogParentOf(project)}/catalogs/default_catalog`;

export const missingNameOf = (project: string) =>
  `${defaultCatalogOf(project)}/catalogItems/alchemy-missing`;

export const entitlementTags = ["Forbidden", "NotFound"] as const;

/**
 * `NotFound` on a missing item means the Recommendations AI API is
 * reachable. `Forbidden` is the entitlement rejection (`get` does not
 * type `BadRequest`).
 */
export const probeCatalogAccess = currentProject.pipe(
  Effect.flatMap((project) =>
    recommendationengine.getProjectsLocationsCatalogsCatalogItems({
      name: missingNameOf(project),
    }),
  ),

  Effect.as("ok" as const),
  Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
  Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
);
