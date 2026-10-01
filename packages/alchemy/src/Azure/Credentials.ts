import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AuthError, NeedsReauth } from "../Auth/AuthProvider.ts";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  AZURE_AUTH_PROVIDER_NAME,
  type AzureAuthConfig,
  type AzureResolvedCredentials,
} from "./AuthProvider.ts";
import { makeTokenCache } from "./Token.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  type Config as CredentialsConfig,
} from "@distilled.cloud/azure";

/**
 * Resolve the Azure service principal for the configured profile (or the
 * CI environment). The resolved value is cached for the layer's lifetime.
 */
export const resolveAzureCredentials = Effect.gen(function* () {
  const { profileName, resolve } = yield* resolveProviderConfig<
    AzureAuthConfig,
    AzureResolvedCredentials
  >(AZURE_AUTH_PROVIDER_NAME);
  const resolved: Effect.Effect<
    AzureResolvedCredentials,
    AuthError | NeedsReauth
  > = resolve;
  return yield* resolved.pipe(
    Effect.mapError(
      (e) =>
        new ConfigError({
          message: `Failed to resolve Azure credentials from ${profileName === undefined ? "the environment" : `profile '${profileName}'`}: ${e.message}`,
        }),
    ),
    Effect.cached,
  );
});

/**
 * Build a `Credentials` layer for `@distilled.cloud/azure` from the Alchemy
 * AuthProvider. The distilled SDK takes a bearer token; it is minted from
 * the profile's service principal and refreshed before it expires, since
 * distilled evaluates the credentials effect on every request.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolved = yield* resolveAzureCredentials;
      const token = yield* makeTokenCache;
      return resolved.pipe(
        Effect.flatMap((creds) =>
          token(creds).pipe(
            Effect.map((minted) => ({
              bearerToken: minted.accessToken,
              subscriptionId: creds.subscriptionId,
              tenantId: creds.tenantId,
              apiBaseUrl: DEFAULT_API_BASE_URL,
            })),
            Effect.mapError(
              (e) =>
                new ConfigError({
                  message: `Failed to mint an Azure access token: ${e.message}`,
                }),
            ),
          ),
        ),
        // Distilled `Credentials` is `Effect<Config>` (error `never`).
        Effect.orDie,
      );
    }),
  );
