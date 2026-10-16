import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/openai/Credentials";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  deferUntilFirstUse,
  orDieCredentialsUnavailable,
  resolveProviderConfig,
} from "../Auth/Resolve.ts";
import {
  OPENAI_AUTH_PROVIDER_NAME,
  type OpenAIAuthConfig,
  type OpenAIResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_API_BASE_URL,
  fromApiKey,
} from "@distilled.cloud/openai/Credentials";

/**
 * Build an OpenAI `Credentials` Layer that resolves the API key and Admin key
 * via the Alchemy AuthProvider: environment variables (`OPENAI_API_KEY`,
 * `OPENAI_ADMIN_KEY`) when present, otherwise the selected profile.
 * Resolution is deferred until the first OpenAI call, so building the layer
 * never requires a configured profile.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const apiBaseUrl = yield* Config.String("OPENAI_BASE_URL").pipe(
        Config.withDefault(DEFAULT_API_BASE_URL),
      );
      const resolve = yield* resolveProviderConfig<OpenAIAuthConfig, OpenAIResolvedCredentials>(
        OPENAI_AUTH_PROVIDER_NAME,
      ).pipe(
        Effect.flatMap(({ profileName, resolve }) =>
          resolve.pipe(
            Effect.map((creds) => ({
              apiKey: creds.apiKey,
              adminKey: creds.adminKey,
              organization: creds.organization,
              apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
            })),
            Effect.mapError(
              (e) =>
                new ConfigError({
                  message: `Failed to resolve OpenAI credentials from ${profileName === undefined ? "the environment" : `profile '${profileName}'`}: ${e.message}`,
                }),
            ),
          ),
        ),
        deferUntilFirstUse,
      );
      return yield* resolve.pipe(
        orDieCredentialsUnavailable(OPENAI_AUTH_PROVIDER_NAME),
        Effect.cached,
      );
    }),
  );
