import {
  type Config as OpenRouterClientConfig,
  Credentials,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/openrouter/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import { deferUntilFirstUse, resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  OPENROUTER_AUTH_PROVIDER_NAME,
  type OpenRouterAuthConfig,
  type OpenRouterResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  credentials,
  fromApiKey,
  fromManagementKey,
} from "@distilled.cloud/openrouter/Credentials";

/**
 * Build a `Credentials` layer that resolves OpenRouter keys via the Alchemy
 * AuthProvider: environment variables (`OPENROUTER_API_KEY` /
 * `OPENROUTER_MANAGEMENT_KEY`) when present, otherwise the selected profile.
 *
 * OpenRouter serves a set of public endpoints (`listModels`,
 * `listProviders`, …) that need no key, so when no credentials are
 * configured this resolves to an anonymous client and logs a warning rather
 * than failing: public calls keep working, and key-gated calls fail with the
 * SDK's typed `InvalidApiKey` error.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      // Defer profile lookup and credential resolution until first use, so
      // building the provider layers never requires a configured profile.
      const resolve = yield* resolveProviderConfig<
        OpenRouterAuthConfig,
        OpenRouterResolvedCredentials
      >(OPENROUTER_AUTH_PROVIDER_NAME).pipe(
        Effect.flatMap(({ resolve }) => resolve),
        Effect.map((creds): OpenRouterClientConfig => ({
          apiKey: creds.apiKey,
          managementKey: creds.managementKey,
          apiBaseUrl: creds.apiBaseUrl,
        })),
        Effect.catch((error) =>
          Effect.logWarning(
            `OpenRouter credentials are not configured (${
              Predicate.hasProperty(error, "message") ? String(error.message) : String(error)
            }); continuing without a key — only public endpoints will work.`,
          ).pipe(Effect.as<OpenRouterClientConfig>({ apiBaseUrl: DEFAULT_API_BASE_URL })),
        ),
        deferUntilFirstUse,
      );
      return yield* Effect.cached(resolve);
    }),
  );
