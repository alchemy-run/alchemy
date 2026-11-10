import type { DockerImagePublicationError } from "@alchemy.run/docker/RegistryError";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Retries an image build or push on transient registry errors. It never
 * imposes a deadline: a build or push takes as long as the image needs.
 */
export const retryContainerPublication = <A, E extends DockerImagePublicationError, R>(
  publication: Effect.Effect<A, E, R>,
) =>
  Effect.retry(publication, {
    while: (error) =>
      error._tag === "DockerRegistryBlobUnknown" || error._tag === "DockerRegistryUnavailable",
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(5)]),
  });
