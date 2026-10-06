import {
  Credentials,
  DEFAULT_API_BASE_URL,
  DEFAULT_API_VERSION,
} from "@distilled.cloud/anthropic/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  deferUntilFirstUse,
  orDieCredentialsUnavailable,
  resolveProviderConfig,
} from "../Auth/Resolve.ts";
import {
  ANTHROPIC_AUTH_PROVIDER_NAME,
  type AnthropicAuthConfig,
  type AnthropicResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  fromAdminKey,
  fromApiKey,
  fromAuthToken,
  DEFAULT_API_BASE_URL,
  DEFAULT_API_VERSION,
  type Config as CredentialsConfig,
} from "@distilled.cloud/anthropic/Credentials";

/**
 * Build a `Credentials` layer that resolves Anthropic credentials via the
 * Alchemy AuthProvider: environment variables when present, otherwise the
 * selected profile.
 *
 * Maps onto `@distilled.cloud/anthropic`'s `{ apiKey, adminKey, authToken }`
 * shape — the SDK picks the admin key for `/v1/organizations/*` routes and the
 * API key everywhere else.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      // Defer profile lookup and credential resolution until first use, so
      // building the provider layers never requires a configured profile.
      const resolve = yield* resolveProviderConfig<
        AnthropicAuthConfig,
        AnthropicResolvedCredentials
      >(ANTHROPIC_AUTH_PROVIDER_NAME).pipe(
        Effect.flatMap(({ profileName, resolve }) =>
          resolve.pipe(
            Effect.map((creds) => ({
              apiKey: creds.apiKey,
              adminKey: creds.adminKey,
              authToken: creds.authToken,
              apiBaseUrl: creds.apiBaseUrl ?? DEFAULT_API_BASE_URL,
              apiVersion: DEFAULT_API_VERSION,
            })),
            Effect.mapError(
              (e) =>
                new ConfigError({
                  message: `Failed to resolve Anthropic credentials from ${profileName === undefined ? "the CI environment" : `profile '${profileName}'`}: ${(e as { message?: string }).message ?? String(e)}`,
                }),
            ),
          ),
        ),
        deferUntilFirstUse,
      );
      return yield* resolve.pipe(
        orDieCredentialsUnavailable(ANTHROPIC_AUTH_PROVIDER_NAME),
        Effect.cached,
      );
    }),
  );
