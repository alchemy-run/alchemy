import * as placeactions from "@distilled.cloud/gcp/mybusinessplaceactions_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import {
  PROBE_NAME,
  PROBE_PARENT,
} from "@/GCP/Mybusinessplaceactions/internal.ts";

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const entitlementTags = ["Forbidden", "NotFound", "BadRequest"] as const;

export { PROBE_NAME, PROBE_PARENT };

export const testParent =
  process.env.GCP_MYBUSINESS_LOCATION?.trim() ||
  process.env.GCP_PLACE_ACTION_PARENT?.trim() ||
  PROBE_PARENT;

export const testUri =
  process.env.GCP_PLACE_ACTION_URI?.trim() ||
  "https://example.com/alchemy-shop";

export const probePlaceActionAccess = placeactions
  .listPlaceActionTypeMetadata({ pageSize: 1 })
  .pipe(
    Effect.as("ok" as const),
    Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
    Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
  );

export const probeCreateAccess = placeactions
  .createLocationsPlaceActionLinks({
    parent: testParent,
    body: {
      uri: "https://example.com/alchemy-place-action-probe",
      placeActionType: "SHOP_ONLINE",
    },
  })
  .pipe(
    Effect.flatMap((link) =>
      link.name
        ? placeactions
            .deleteLocationsPlaceActionLinks({ name: link.name })
            .pipe(
              Effect.as("ok" as const),
              Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
            )
        : Effect.succeed("ok" as const),
    ),
    Effect.catchTag("Conflict", () => Effect.succeed("ok" as const)),
    Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
    Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
    Effect.catchTag("BadRequest", (error) => Effect.succeed(error)),
  );
