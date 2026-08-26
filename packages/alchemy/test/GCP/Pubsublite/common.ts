import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
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
export const region = "us-central1";
export const zone = "us-central1-a";

export const entitlementTags = ["Forbidden"] as const;

export type ProbeResult =
  | { tag: "ok" }
  | { tag: (typeof entitlementTags)[number]; message: string | undefined };

export const probeReservations = (
  parent = `projects/${project}/locations/${region}`,
) =>
  pubsublite
    .createAdminProjectsLocationsReservations({
      parent,
      reservationId: "alchemy-probe-reservation",
      body: { throughputCapacity: "1" },
    })
    .pipe(
      Effect.flatMap((created) =>
        created.name
          ? pubsublite
              .deleteAdminProjectsLocationsReservations({ name: created.name })
              .pipe(Effect.catchTag("NotFound", () => Effect.void))
          : Effect.void,
      ),
      Effect.map((): ProbeResult => ({ tag: "ok" })),
      Effect.catchTag("Forbidden", (error) =>
        Effect.succeed({
          tag: "Forbidden" as const,
          message: error.message,
        }),
      ),
      Effect.catchTag(["NotFound", "BadRequest"], (error) =>
        Effect.succeed({
          tag: "Forbidden" as const,
          message: error.message,
        }),
      ),
      Effect.catchTag("Conflict", () => Effect.succeed({ tag: "ok" as const })),
    );

export const probeTopics = (parent = `projects/${project}/locations/${zone}`) =>
  pubsublite
    .createAdminProjectsLocationsTopics({
      parent,
      topicId: "alchemy-probe-topic",
      body: {
        partitionConfig: {
          count: "1",
          capacity: { publishMibPerSec: 4, subscribeMibPerSec: 4 },
        },
        retentionConfig: { perPartitionBytes: "32212254720" },
      },
    })
    .pipe(
      Effect.flatMap((created) =>
        created.name
          ? pubsublite
              .deleteAdminProjectsLocationsTopics({ name: created.name })
              .pipe(Effect.catchTag("NotFound", () => Effect.void))
          : Effect.void,
      ),
      Effect.map((): ProbeResult => ({ tag: "ok" })),
      Effect.catchTag("Forbidden", (error) =>
        Effect.succeed({
          tag: "Forbidden" as const,
          message: error.message,
        }),
      ),
      Effect.catchTag(["NotFound", "BadRequest"], (error) =>
        Effect.succeed({
          tag: "Forbidden" as const,
          message: error.message,
        }),
      ),
      Effect.catchTag("Conflict", () => Effect.succeed({ tag: "ok" as const })),
    );

export const waitUntilGone = <E extends { readonly _tag: string }, R>(
  get: Effect.Effect<unknown, E, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
