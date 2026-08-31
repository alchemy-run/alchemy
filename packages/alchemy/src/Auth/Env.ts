import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as CliKit from "../Cli/CliKit/index.ts";
import { AuthError } from "./AuthProvider.ts";

export const getEnv = (key: string) =>
  Config.option(Config.string(key)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError(
      (cause) =>
        new AuthError({
          message: `Could not read optional env: ${key}`,
          cause,
        }),
    ),
  );

export const getEnvRequired = (key: string) =>
  Config.string(key).pipe(
    Effect.mapError(
      (cause) =>
        new AuthError({ message: `Missing required env: ${key}`, cause }),
    ),
  );

export const getEnvRedacted = (key: string) =>
  Config.option(Config.redacted(key)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError(
      (cause) =>
        new AuthError({
          message: `Could not read optional env: ${key}`,
          cause,
        }),
    ),
  );

export const getEnvRedactedRequired = (key: string) =>
  Config.redacted(key).pipe(
    Effect.mapError(
      (cause) =>
        new AuthError({ message: `Missing required env: ${key}`, cause }),
    ),
  );

export const mapPromptCancellation = <A, R>(
  self: Effect.Effect<A, CliKit.InteractionError, R>,
) =>
  self.pipe(
    Effect.mapError(
      (cause) =>
        new AuthError({
          message:
            cause._tag === "TerminalCancelled"
              ? "User cancelled prompt"
              : cause.message,
          cause,
        }),
    ),
  );
