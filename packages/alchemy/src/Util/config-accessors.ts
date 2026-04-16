import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const getEnv = (key: string) =>
  Config.string(key)
    .asEffect()
    .pipe(Effect.catch(() => Effect.succeed(undefined)));

export const getEnvRequired = (key: string) =>
  Config.string(key)
    .asEffect()
    .pipe(Effect.catch(() => Effect.die(`Missing required env: ${key}`)));

export const getEnvRedacted = (key: string) =>
  Config.redacted(key)
    .asEffect()
    .pipe(Effect.catch(() => Effect.succeed(undefined)));

export const getEnvRedactedRequired = (key: string) =>
  Config.redacted(key)
    .asEffect()
    .pipe(Effect.catch(() => Effect.die(`Missing required env: ${key}`)));
