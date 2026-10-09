import { DEFAULT_API_BASE_URL } from "@distilled.cloud/openrouter/Credentials";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { AuthError } from "../Auth/AuthProvider.ts";
import { getEnv, getEnvRedacted } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

export const OPENROUTER_AUTH_PROVIDER_NAME = "OpenRouter";
/** Inference API key (`sk-or-v1-…`). */
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
/** Management (provisioning) key used for API keys, guardrails and other admin routes. */
export const OPENROUTER_MANAGEMENT_KEY_ENV = "OPENROUTER_MANAGEMENT_KEY";
/** Optional API base URL override. */
export const OPENROUTER_BASE_URL_ENV = "OPENROUTER_BASE_URL";

export type OpenRouterAuthConfig = StoredAuthConfig;

/**
 * Resolved OpenRouter credentials. OpenRouter issues two kinds of key, both
 * sent as `Authorization: Bearer`: an inference **API key** and a
 * **management key** for the account-administration routes (`/keys`,
 * `/guardrails`, …). The SDK picks the right one per operation and falls
 * back to whichever is configured.
 */
export interface OpenRouterResolvedCredentials {
  readonly apiKey: Redacted.Redacted<string> | undefined;
  readonly managementKey: Redacted.Redacted<string> | undefined;
  readonly apiBaseUrl: string;
  readonly source: { type: OpenRouterAuthConfig["method"] | "env"; details?: string };
}

const readEnvironment = Effect.gen(function* () {
  const apiKey = yield* getEnvRedacted(OPENROUTER_API_KEY_ENV);
  const managementKey = yield* getEnvRedacted(OPENROUTER_MANAGEMENT_KEY_ENV);
  if (apiKey === undefined && managementKey === undefined) {
    return yield* new AuthError({
      message: `OpenRouter CI credentials not found. Set ${OPENROUTER_API_KEY_ENV} and/or ${OPENROUTER_MANAGEMENT_KEY_ENV}.`,
    });
  }
  return {
    apiKey,
    managementKey,
    apiBaseUrl: (yield* getEnv(OPENROUTER_BASE_URL_ENV)) ?? DEFAULT_API_BASE_URL,
    source: { type: "env" as const },
  } satisfies OpenRouterResolvedCredentials;
});

const openRouterAuth = makeStoredAuthProvider<OpenRouterResolvedCredentials>({
  provider: OPENROUTER_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiKey",
      label: "OpenRouter API Key",
      description: "Inference key (sk-or-v1-…) used for chat completions and other runtime calls.",
      secret: true,
    },
    {
      name: "managementKey",
      label: "OpenRouter Management Key",
      description:
        "Provisioning key required to deploy OpenRouter.ApiKey and OpenRouter.Guardrail resources.",
      secret: true,
      optional: true,
    },
    {
      name: "apiBaseUrl",
      label: "OpenRouter API Base URL",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values, source) => ({
    apiKey: storedSecret(values.apiKey),
    managementKey: storedSecret(values.managementKey),
    apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: OPENROUTER_API_KEY_ENV,
      required: false,
      secret: true,
      description: `Inference API key. Set this and/or ${OPENROUTER_MANAGEMENT_KEY_ENV}.`,
    },
    {
      name: OPENROUTER_MANAGEMENT_KEY_ENV,
      required: false,
      secret: true,
      description: "Management key for API keys, guardrails and other account administration.",
    },
    {
      name: OPENROUTER_BASE_URL_ENV,
      required: false,
      description: `API base URL (default ${DEFAULT_API_BASE_URL}).`,
    },
  ],
});

/**
 * Layer that registers the OpenRouter {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Included in
 * `OpenRouter.providers()` so `alchemy profile edit` can configure it.
 */
export const OpenRouterAuth = openRouterAuth.layer;

/** Schema of OpenRouter's inline stored-key values. */
export const OpenRouterStoredCredentials = openRouterAuth.storedSchema;
export type OpenRouterStoredCredentials = typeof OpenRouterStoredCredentials.Type;
