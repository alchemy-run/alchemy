import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type { DockerImagePublicationError } from "./RegistryError.ts";

export const retryImagePublication = <A, R>(
  publication: Effect.Effect<A, DockerImagePublicationError, R>,
) =>
  Effect.retry(publication, {
    while: (error) =>
      error._tag === "DockerRegistryBlobUnknown" ||
      error._tag === "DockerRegistryUnavailable",
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(5)]),
  });

/** Serializes observation and publication of the same registry reference. */
export class ImagePublication extends Context.Service<
  ImagePublication,
  {
    readonly withLock: <A, E, R>(
      reference: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("Docker.ImagePublication") {}

export const ImagePublicationLive = Layer.effect(
  ImagePublication,
  Effect.sync(() => {
    const locks = new Map<string, Semaphore.Semaphore>();
    return ImagePublication.of({
      withLock: (reference, effect) =>
        Effect.suspend(() => {
          let lock = locks.get(reference);
          if (!lock) {
            lock = Semaphore.makeUnsafe(1);
            locks.set(reference, lock);
          }
          return lock.withPermit(effect);
        }),
    });
  }),
);
