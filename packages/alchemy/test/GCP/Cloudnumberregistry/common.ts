import * as cnr from "@distilled.cloud/gcp/cloudnumberregistry_v1alpha";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const runLifecycle = hasGcpCreds && !process.env.FAST;

export const project = process.env.GOOGLE_PROJECT_ID ?? "";
export const location = "global";

export const entitlementTags = ["Forbidden", "NotFound"] as const;

export type ProbeResult =
  | { tag: "ok" }
  | { tag: (typeof entitlementTags)[number]; message: string | undefined };

export const probeRegistryBooks = (
  parent = `projects/${project}/locations/${location}`,
) =>
  cnr
    .listProjectsLocationsRegistryBooks({
      parent,
      pageSize: 1,
    })
    .pipe(
      Effect.map((): ProbeResult => ({ tag: "ok" })),
      Effect.catchTag("Forbidden", (error) =>
        Effect.succeed({
          tag: "Forbidden" as const,
          message: error.message,
        }),
      ),
      Effect.catchTag("NotFound", (error) =>
        Effect.succeed({
          tag: "NotFound" as const,
          message: error.message,
        }),
      ),
    );

export const probeIpamAdminScopes = (
  parent = `projects/${project}/locations/${location}`,
) =>
  cnr
    .listProjectsLocationsIpamAdminScopes({
      parent,
      pageSize: 1,
    })
    .pipe(
      Effect.map((): ProbeResult => ({ tag: "ok" })),
      Effect.catchTag("Forbidden", (error) =>
        Effect.succeed({
          tag: "Forbidden" as const,
          message: error.message,
        }),
      ),
      Effect.catchTag("NotFound", (error) =>
        Effect.succeed({
          tag: "NotFound" as const,
          message: error.message,
        }),
      ),
    );

export const waitUntilGone = <E, R>(get: Effect.Effect<unknown, E, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound" as never, () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden" as never, () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
