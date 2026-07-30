import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import path from "pathe";
import { writeFileAtomic } from "../Util/AtomicFile.ts";
import { AuthError } from "./AuthProvider.ts";
import { profileCredentialsDirPath, validateProfileName } from "./Profile.ts";

export const credentialsFilePath = (profile: string, provider: string) =>
  path.join(profileCredentialsDirPath(profile), `${provider}.json`);

/**
 * Service exposing per-profile credential file helpers. All methods have
 * `R = never` — the {@link FileSystem.FileSystem} requirement is captured
 * by {@link CredentialsStoreLive} when the layer is built.
 */
export interface CredentialsStoreService {
  readonly read: <T>(
    profile: string,
    provider: string,
  ) => Effect.Effect<T | undefined, AuthError>;
  readonly write: <T>(
    profile: string,
    provider: string,
    credentials: T,
  ) => Effect.Effect<void, AuthError>;
  readonly delete: (
    profile: string,
    provider: string,
  ) => Effect.Effect<void, AuthError>;
  /**
   * Recursively remove the `~/.alchemy/credentials/{profile}` directory
   * containing all per-provider secrets for `profile`. No-op if it doesn't exist.
   */
  readonly deleteProfile: (profile: string) => Effect.Effect<void, AuthError>;
}

export class CredentialsStore extends Context.Service<
  CredentialsStore,
  CredentialsStoreService
>()("Alchemy::CredentialsStore") {}

export const CredentialsStoreLive = Layer.effect(
  CredentialsStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const read = <T>(
      profile: string,
      provider: string,
    ): Effect.Effect<T | undefined, AuthError> =>
      validateCredentialPath(profile, provider).pipe(
        Effect.flatMap((filePath) =>
          fs.readFileString(filePath).pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "NotFound",
              () => Effect.succeed(undefined),
            ),
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: `Could not read credentials at '${filePath}'.`,
                  cause,
                }),
            ),
          ),
        ),
        Effect.flatMap((data) => {
          if (data === undefined) return Effect.succeed(undefined);
          return Effect.try({
            try: () => JSON.parse(data) as T,
            catch: (cause) =>
              new AuthError({
                message: "Stored credentials contain invalid JSON.",
                cause,
              }),
          });
        }),
      );

    const write = <T>(
      profile: string,
      provider: string,
      credentials: T,
    ): Effect.Effect<void, AuthError> =>
      validateCredentialPath(profile, provider).pipe(
        Effect.flatMap((filePath) =>
          fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
            Effect.flatMap(() => fs.chmod(path.dirname(filePath), 0o700)),
            Effect.flatMap(() =>
              writeFileAtomic(
                fs,
                filePath,
                JSON.stringify(credentials, null, 2),
                0o600,
              ),
            ),
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: `Could not write credentials at '${filePath}'.`,
                  cause,
                }),
            ),
          ),
        ),
      );

    const remove_ = (
      profile: string,
      provider: string,
    ): Effect.Effect<void, AuthError> =>
      validateCredentialPath(profile, provider).pipe(
        Effect.flatMap((filePath) =>
          fs.remove(filePath).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.void,
            ),
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: `Could not delete credentials at '${filePath}'.`,
                  cause,
                }),
            ),
          ),
        ),
      );

    const deleteProfile = (profile: string): Effect.Effect<void, AuthError> =>
      validateProfileName(profile).pipe(
        Effect.mapError(
          (cause) => new AuthError({ message: cause.message, cause }),
        ),
        Effect.flatMap(() =>
          fs
            .remove(profileCredentialsDirPath(profile), {
              recursive: true,
            })
            .pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.void,
              ),
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message: `Could not delete credentials for profile '${profile}'.`,
                    cause,
                  }),
              ),
            ),
        ),
      );

    return {
      read,
      write,
      delete: remove_,
      deleteProfile,
    } satisfies CredentialsStoreService;
  }),
);

const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const validateCredentialPath = (
  profile: string,
  provider: string,
): Effect.Effect<string, AuthError> =>
  validateProfileName(profile).pipe(
    Effect.mapError(
      (cause) => new AuthError({ message: cause.message, cause }),
    ),
    Effect.flatMap(() =>
      CREDENTIAL_KEY_PATTERN.test(provider)
        ? Effect.succeed(credentialsFilePath(profile, provider))
        : Effect.fail(
            new AuthError({
              message: `Invalid credential key '${provider}'.`,
            }),
          ),
    ),
  );

export function displayRedacted(
  r: Redacted.Redacted<string>,
  visibleChars = 4,
): string {
  const raw = Redacted.value(r);
  if (raw.length <= visibleChars) return "****";
  return `${raw.slice(0, visibleChars)}****`;
}
