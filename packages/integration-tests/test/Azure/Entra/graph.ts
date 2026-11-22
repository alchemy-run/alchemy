import * as applications from "@distilled.cloud/microsoft-graph/applications";
import * as directory from "@distilled.cloud/microsoft-graph/directory";
import * as servicePrincipals from "@distilled.cloud/microsoft-graph/servicePrincipals";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Directory reads trail writes by seconds: retry `ResourceNotFound` right
 * after a deploy (bounded to ~30 s).
 */
const afterWrite = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceNotFound",
  schedule: Schedule.spaced("2 seconds"),
  times: 15,
} as const;

export const getApplication = (objectId: string) =>
  applications.getApplication({ applicationId: objectId }).pipe(Effect.retry(afterWrite));

export const getServicePrincipal = (objectId: string) =>
  servicePrincipals
    .getServicePrincipal({ servicePrincipalId: objectId })
    .pipe(Effect.retry(afterWrite));

/** Poll until `status` reports `gone` (bounded to ~60 s). */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (s) => s === "gone",
      times: 40,
    }),
  );

export const applicationGone = (objectId: string) =>
  untilGone(
    applications.getApplication({ applicationId: objectId }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    ),
  );

export const servicePrincipalGone = (objectId: string) =>
  untilGone(
    servicePrincipals.getServicePrincipal({ servicePrincipalId: objectId }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    ),
  );

/** Whether the deleted object was purged from the directory's deleted items. */
export const purged = (objectId: string) =>
  untilGone(
    directory.getDeletedItems({ directoryObjectId: objectId }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    ),
  );

/**
 * Re-read until `until` holds (bounded to ~60 s): Graph reads trail writes,
 * so an update is not visible on every replica at once.
 */
export const eventually = <A, E, R>(read: Effect.Effect<A, E, R>, until: (value: A) => boolean) =>
  read.pipe(Effect.repeat({ schedule: Schedule.spaced("3 seconds"), until, times: 20 }));
