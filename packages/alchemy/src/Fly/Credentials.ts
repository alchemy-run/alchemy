import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/fly-io";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  FLY_AUTH_PROVIDER_NAME,
  type FlyAuthConfig,
  type FlyResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
  type Config as CredentialsConfig,
} from "@distilled.cloud/fly-io";

/**
 * Build a `Credentials` layer that resolves Fly credentials via the current
 * Alchemy profile, or directly from environment variables in CI.
 *
 * Maps onto `@distilled.cloud/fly-io`'s `{ apiKey, apiBaseUrl }` shape.
 * Distilled's own `CredentialsFromEnv` also accepts `FLY_IO_API_KEY` as a
 * fallback — Alchemy itself only reads `FLY_API_TOKEN`.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const { profileName, resolve } = yield* resolveProviderConfig<
        FlyAuthConfig,
        FlyResolvedCredentials
      >(FLY_AUTH_PROVIDER_NAME);

      return yield* resolve.pipe(
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          apiBaseUrl: creds.apiBaseUrl,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Fly credentials from ${profileName === undefined ? "the CI environment" : `profile '${profileName}'`}: ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
