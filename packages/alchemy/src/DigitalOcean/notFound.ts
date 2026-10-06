import type { NotFound } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Observes a resource that may not exist. */
export const noneIfNotFound = <A, E, R>(read: Effect.Effect<A, E | NotFound, R>) =>
  read.pipe(
    Effect.map(Option.some),
    Effect.catchTag("NotFound", () => Effect.succeed(Option.none<A>())),
  );

/** Deletes and unassignments succeed when the target is already gone. */
export const ignoreNotFound = <A, E, R>(effect: Effect.Effect<A, E | NotFound, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );
