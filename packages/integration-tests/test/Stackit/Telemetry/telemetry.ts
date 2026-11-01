import { expect } from "@alchemy.run/test";
import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT Telemetry Router suites. The router itself has no fee in
 * the price list, only the data routed through it, and these suites route nothing, so
 * they run ungated.
 */

/** An endpoint nothing listens on. STACKIT isn't known to check it on create. */
export const OTLP_URI = "https://otlp.example.com/otlp/v1/logs";

/** The router, or `"gone"` on the typed `NotFound`. */
export const observeRouter = (projectId: string, regionId: string, telemetryRouterId: string) =>
  router
    .getTelemetryRouter({ projectId, regionId, telemetryRouterId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The destination, or `"gone"` on the typed `NotFound`. */
export const observeDestination = (
  projectId: string,
  regionId: string,
  telemetryRouterId: string,
  destinationId: string,
) =>
  router
    .getDestination({ projectId, regionId, telemetryRouterId, destinationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The access token, or `"gone"` on the typed `NotFound`. */
export const observeAccessToken = (
  projectId: string,
  regionId: string,
  telemetryRouterId: string,
  accessTokenId: string,
) =>
  router
    .getAccessToken({ projectId, regionId, telemetryRouterId, accessTokenId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 12,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
