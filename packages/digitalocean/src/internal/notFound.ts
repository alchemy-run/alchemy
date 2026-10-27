import type { NotFound } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";

export const noneIfNotFound = <A, E, R>(read: Effect.Effect<A, E | NotFound, R>) =>
  read.pipe(
    Effect.asSome,
    Effect.catchTag("NotFound", () => Effect.succeedNone),
  );

export const ignoreNotFound = <A, E, R>(effect: Effect.Effect<A, E | NotFound, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );
