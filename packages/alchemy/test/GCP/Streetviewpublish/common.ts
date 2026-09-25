import * as streetviewpublish from "@distilled.cloud/gcp/streetviewpublish_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const entitlementTags = ["Forbidden", "BadRequest", "NotFound"] as const;

export const probePhotoAccess = streetviewpublish
  .startUploadPhoto({ body: {} })
  .pipe(
    Effect.as("ok" as const),
    Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
    Effect.catchTag("BadRequest", (error) => Effect.succeed(error)),
    Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
  );

export const probeSequenceAccess = streetviewpublish
  .startUploadPhotoSequence({ body: {} })
  .pipe(
    Effect.as("ok" as const),
    Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
    Effect.catchTag("BadRequest", (error) => Effect.succeed(error)),
    Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
  );
