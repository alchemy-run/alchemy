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
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
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

const METADATA_ROOT = "http://metadata.google.internal/computeMetadata/v1";
const METADATA_HEADERS = { "Metadata-Flavor": "Google" };

const metadataRequest = (path: string) =>
  HttpClientRequest.get(`${METADATA_ROOT}${path}`).pipe(
    HttpClientRequest.setHeaders(METADATA_HEADERS),
  );

const toConfigError = (message: string) => (cause: unknown) =>
  new ConfigError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const fetchMetadataToken = (http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const response = yield* http
      .execute(metadataRequest("/instance/service-accounts/default/token"))
      .pipe(
        Effect.mapError(
          toConfigError(
            "Failed to fetch GCP credentials from the GCE metadata server",
          ),
        ),
      );
    if (response.status !== 200) {
      return yield* new ConfigError({
        message: `GCE metadata token endpoint returned ${response.status}`,
      });
    }
    const body = yield* response.json.pipe(
      Effect.mapError(
        toConfigError("GCE metadata token endpoint returned invalid JSON"),
      ),
    );
    const token =
      typeof body === "object" &&
      body !== null &&
      "access_token" in body &&
      typeof body.access_token === "string"
        ? body.access_token
        : undefined;
    if (token === undefined) {
      return yield* new ConfigError({
        message: "GCE metadata token endpoint returned no access_token",
      });
    }
    return token;
  });

const fetchMetadataProject = (http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const response = yield* http
      .execute(metadataRequest("/project/project-id"))
      .pipe(
        Effect.mapError(
          toConfigError(
            "Failed to fetch GCP project id from the GCE metadata server",
          ),
        ),
      );
    if (response.status !== 200) {
      return yield* new ConfigError({
        message: `GCE metadata project-id endpoint returned ${response.status}`,
      });
    }
    const text = yield* response.text.pipe(
      Effect.mapError(
        toConfigError("GCE metadata project-id endpoint returned invalid text"),
      ),
    );
    return String(text).trim();
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
      const http = yield* HttpClient.HttpClient;
      return Effect.gen(function* () {
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
            accessToken: Redacted.make(envToken.value),
            project: Option.getOrUndefined(envProject),
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

        const accessToken = yield* fetchMetadataToken(http);
        const project =
          Option.getOrUndefined(envProject) ??
          (yield* fetchMetadataProject(http).pipe(
            Effect.orElseSucceed(() => undefined),
          ));
        return {
          accessToken: Redacted.make(accessToken),
          project,
        };
      }).pipe(
        // Distilled `Credentials` is `Effect<Config>` (error `never`).
        Effect.orDie,
      ) as Effect.Effect<CredentialsConfig>;
    }),
  );
