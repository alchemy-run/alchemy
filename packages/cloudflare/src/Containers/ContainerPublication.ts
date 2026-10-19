import type { DockerImagePublicationError } from "alchemy/Docker/RegistryError";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export const retryContainerPublication = <A, R>(
  publication: Effect.Effect<A, DockerImagePublicationError, R>,
) =>
  Effect.retry(publication, {
    while: (error) =>
      error._tag === "DockerRegistryBlobUnknown" || error._tag === "DockerRegistryUnavailable",
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(5)]),
  });
