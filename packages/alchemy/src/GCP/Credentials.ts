import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  GCP_AUTH_PROVIDER_NAME,
  type GcpAuthConfig,
  type GcpResolvedCredentials,
} from "./AuthProvider.ts";
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
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        GcpAuthConfig,
        GcpResolvedCredentials
      >(GCP_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      // Return the resolver Effect (not a one-shot token). Distilled yields
      // `Credentials` then the inner Effect on every call so SA tokens can
      // refresh from AuthProvider's cache.
      return profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as GcpAuthConfig),
        ),
        Effect.map((creds) => ({
          accessToken: creds.accessToken,
          project: creds.project,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve GCP credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
      );
    }),
  );

const METADATA_ROOT = "http://metadata.google.internal/computeMetadata/v1";
const METADATA_HEADERS = { "Metadata-Flavor": "Google" };

const fetchMetadataToken = Effect.tryPromise({
  try: async () => {
    const response = await fetch(
      `${METADATA_ROOT}/instance/service-accounts/default/token`,
      { headers: METADATA_HEADERS },
    );
    if (!response.ok) {
      throw new Error(
        `GCE metadata token endpoint returned ${response.status}`,
      );
    }
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string") {
      throw new Error("GCE metadata token endpoint returned no access_token");
    }
    return body.access_token;
  },
  catch: (cause) =>
    new ConfigError({
      message: `Failed to fetch GCP credentials from the GCE metadata server: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
});

const fetchMetadataProject = Effect.tryPromise({
  try: async () => {
    const response = await fetch(`${METADATA_ROOT}/project/project-id`, {
      headers: METADATA_HEADERS,
    });
    if (!response.ok) {
      throw new Error(
        `GCE metadata project-id endpoint returned ${response.status}`,
      );
    }
    return (await response.text()).trim();
  },
  catch: (cause) =>
    new ConfigError({
      message: `Failed to fetch GCP project id from the GCE metadata server: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
});

/**
 * GCP credential chain for Effect-native GKE workload pods (and local
 * processes): `GOOGLE_ACCESS_TOKEN`, then
 * `GOOGLE_APPLICATION_CREDENTIALS`, then the GCE metadata server
 * (Workload Identity).
 */
export const fromChain = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return Effect.gen(function* () {
        const envToken = yield* Config.option(
          Config.string("GOOGLE_ACCESS_TOKEN"),
        );
        const envProject = yield* Config.option(
          Config.string("GOOGLE_PROJECT_ID").pipe(
            Config.orElse(() => Config.string("GOOGLE_CLOUD_PROJECT")),
          ),
        );
        if (Option.isSome(envToken)) {
          return {
            accessToken: Redacted.make(envToken.value),
            project: Option.getOrUndefined(envProject),
          };
        }

        const keyFile = yield* Config.option(
          Config.string("GOOGLE_APPLICATION_CREDENTIALS"),
        );
        if (Option.isSome(keyFile)) {
          const raw = yield* fs.readFileString(keyFile.value).pipe(
            Effect.mapError(
              (cause) =>
                new ConfigError({
                  message: `Failed to read GOOGLE_APPLICATION_CREDENTIALS at ${keyFile.value}: ${cause instanceof Error ? cause.message : String(cause)}`,
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
            accessToken: minted.accessToken,
            project:
              Option.getOrUndefined(envProject) ??
              sa.project_id ??
              minted.project,
          };
        }

        const accessToken = yield* fetchMetadataToken;
        const project =
          Option.getOrUndefined(envProject) ??
          (yield* fetchMetadataProject.pipe(
            Effect.orElseSucceed(() => undefined),
          ));
        return {
          accessToken: Redacted.make(accessToken),
          project,
        };
      }).pipe(Effect.orDie);
    }),
  );
