import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Option from "effect/Option";
import * as S from "effect/Schema";
import { AuthError, type AuthProviders } from "../Auth/AuthProvider.ts";
import { SuppressMissingProviderConfig } from "../Auth/Profile.ts";
import {
  buildBuiltinAuthProviders,
  buildStackProviders,
} from "./StackSession.ts";

const isMissingProviderConfig = S.is(
  S.Struct({ _tag: S.Literals(["MissingProviderConfig"]) }),
);

export const collectAuthProviders = Effect.fn("collectAuthProviders")(
  function* (options: {
    readonly main: string;
    readonly envFile: Option.Option<string>;
    readonly profile: string;
  }) {
    const authProviders: AuthProviders["Service"] = {};
    yield* buildBuiltinAuthProviders({
      envFile: options.envFile,
      profile: options.profile,
      registry: authProviders,
    });

    const fs = yield* FileSystem.FileSystem;
    const entrypointExists = yield* fs.exists(options.main);
    const missingDefault =
      options.main === "alchemy.run.ts" && !entrypointExists;
    if (!entrypointExists && !missingDefault) {
      return yield* Effect.fail(
        new AuthError({
          message: `Stack entrypoint '${options.main}' does not exist.`,
        }),
      );
    }
    if (!missingDefault) {
      yield* buildStackProviders({ ...options, registry: authProviders }).pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.catchTag("TimeoutError", () => Effect.void),
        Effect.catchCause((cause) => {
          const suppressed = cause.reasons.some((reason) => {
            const error = Cause.isFailReason(reason)
              ? reason.error
              : Cause.isDieReason(reason)
                ? reason.defect
                : undefined;
            return isMissingProviderConfig(error);
          });
          return suppressed
            ? Effect.void
            : Effect.fail(
                new AuthError({
                  message: `Could not load auth providers from '${options.main}'.`,
                  cause,
                }),
              );
        }),
      );
    }
    return authProviders;
  },
  Effect.provideService(SuppressMissingProviderConfig, true),
);
