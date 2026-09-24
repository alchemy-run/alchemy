import { ConfigError } from "@distilled.cloud/core/errors";
import {
  Credentials,
  type Config as CredentialsConfig,
} from "@distilled.cloud/gcp/Credentials";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  GCP_AUTH_PROVIDER_NAME,
  type GcpAuthConfig,
  type GcpResolvedCredentials,
} from "./AuthProvider.ts";
import {
  cacheCredentials,
  fetchMetadataProject,
  fetchMetadataToken,
} from "./MetadataCredentials.ts";
import { mintAccessToken, parseServiceAccountKey } from "./Token.ts";

export {
  Credentials,
  CredentialsFromEnv,
  fromAccessToken,
  type Config as CredentialsConfig,
} from "@distilled.cloud/gcp/Credentials";

/**
 * Build a `Credentials` layer that resolves GCP credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * Maps onto `@distilled.cloud/gcp`'s `{ accessToken, project }` shape.
 * Access tokens are minted from a service-account key when
 * `GOOGLE_APPLICATION_CREDENTIALS` is set.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const { profileName, resolve } = yield* resolveProviderConfig<
        GcpAuthConfig,
        GcpResolvedCredentials
      >(GCP_AUTH_PROVIDER_NAME);

      // Return the resolver Effect (not a one-shot token). Distilled yields
      // `Credentials` then the inner Effect on every call so SA tokens can
      // refresh from AuthProvider's cache.
      return resolve.pipe(
        Effect.map((creds) => ({
          accessToken: creds.accessToken,
          project: creds.project,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve GCP credentials from ${profileName === undefined ? "the environment" : `profile '${profileName}'`}: ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        // Distilled `Credentials` is `Effect<Config>` (error `never`).
        Effect.orDie,
      );
    }),
  );

/**
 * GCP credential chain for Effect-native GKE workload pods (and local
 * processes): `GOOGLE_ACCESS_TOKEN`, then
 * `GOOGLE_APPLICATION_CREDENTIALS`, then the GCE metadata server
 * (Workload Identity). Minted tokens are cached until shortly before they
 * expire.
 */
export const fromChain = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;
      const cached = yield* cacheCredentials(
        Effect.gen(function* () {
          const envToken = yield* Config.option(
            Config.String("GOOGLE_ACCESS_TOKEN"),
          );
          const envProject = yield* Config.option(
            Config.String("GOOGLE_PROJECT_ID").pipe(
              Config.orElse(() => Config.String("GOOGLE_CLOUD_PROJECT")),
            ),
          );
          if (Option.isSome(envToken)) {
            return {
              config: {
                accessToken: Redacted.make(envToken.value),
                project: Option.getOrUndefined(envProject),
              },
              expiresAt: undefined,
            };
          }

          const keyFile = yield* Config.option(
            Config.String("GOOGLE_APPLICATION_CREDENTIALS"),
          );
          if (Option.isSome(keyFile)) {
            const raw = yield* fs.readFileString(keyFile.value).pipe(
              Effect.mapError(
                (cause) =>
                  new ConfigError({
                    message: `Failed to read GOOGLE_APPLICATION_CREDENTIALS at ${keyFile.value}: ${cause.message}`,
                  }),
              ),
            );
            const sa = yield* parseServiceAccountKey(raw).pipe(
              Effect.mapError(
                (cause) =>
                  new ConfigError({
                    message: `Invalid GOOGLE_APPLICATION_CREDENTIALS JSON: ${cause.message}`,
                  }),
              ),
            );
            const minted = yield* mintAccessToken(sa).pipe(
              Effect.mapError(
                (cause) =>
                  new ConfigError({
                    message: `Failed to mint a Google access token from the service-account key: ${cause.message}`,
                  }),
              ),
            );
            return {
              config: {
                accessToken: minted.accessToken,
                project:
                  Option.getOrUndefined(envProject) ??
                  sa.project_id ??
                  minted.project,
              },
              expiresAt: minted.expirationMs,
            };
          }

          const token = yield* fetchMetadataToken(http);
          const project =
            Option.getOrUndefined(envProject) ??
            (yield* fetchMetadataProject(http).pipe(
              Effect.orElseSucceed(() => undefined),
            ));
          return {
            config: { accessToken: token.accessToken, project },
            expiresAt: token.expiresAt,
          };
        }),
      );
      // Distilled `Credentials` is `Effect<Config>` (error `never`).
      return cached.pipe(Effect.orDie) as Effect.Effect<CredentialsConfig>;
    }),
  );
