import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { AuthError } from "../Auth/AuthProvider.ts";
import { getEnv, getEnvRedacted } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  storedSecret,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

/**
 * Canonical name registered in {@link AuthProviders}. Use this key to look up
 * the Anthropic {@link AuthProvider} from inside provider Layers.
 */
export const ANTHROPIC_AUTH_PROVIDER_NAME = "Anthropic";
/** Inference API key (`sk-ant-api…`), used by the Messages API. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
/** Admin API key (`sk-ant-admin…`), used by the control-plane resources. */
export const ANTHROPIC_ADMIN_KEY_ENV = "ANTHROPIC_ADMIN_KEY";
/** OAuth access token, sent as `Authorization: Bearer` when no key applies. */
export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
/** API root override (default `https://api.anthropic.com`). */
export const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";

export type AnthropicAuthConfig = StoredAuthConfig;

export type AnthropicResolvedCredentials = {
  type: "apiKey";
  /** Inference API key — required by the Messages API (`LanguageModel`). */
  apiKey?: Redacted.Redacted<string>;
  /** Admin API key — required by `Workspace`, `SpendLimit` and other `/v1/organizations/*` resources. */
  adminKey?: Redacted.Redacted<string>;
  /** OAuth bearer token, the fallback for both routes. */
  authToken?: Redacted.Redacted<string>;
  apiBaseUrl?: string;
  source: { type: AnthropicAuthConfig["method"] | "env"; details?: string };
};

const anthropicAuth = makeStoredAuthProvider<AnthropicResolvedCredentials>({
  provider: ANTHROPIC_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiKey",
      label: "Anthropic API key (sk-ant-api…)",
      description: "Used for inference (Messages API).",
      secret: true,
      optional: true,
    },
    {
      name: "adminKey",
      label: "Anthropic Admin API key (sk-ant-admin…)",
      description:
        "Used to manage workspaces and spend limits. Only organization admins can mint one.",
      secret: true,
      optional: true,
    },
  ],
  complete: (values) =>
    values.apiKey === undefined && values.adminKey === undefined
      ? Effect.fail(
          new AuthError({
            message: "Anthropic: provide an API key, an Admin API key, or both.",
          }),
        )
      : Effect.succeed(values),
  toResolved: (values) => ({
    type: "apiKey",
    apiKey: storedSecret(values.apiKey),
    adminKey: storedSecret(values.adminKey),
    source: { type: "stored" },
  }),
  readEnvironment: Effect.gen(function* () {
    const apiKey = yield* getEnvRedacted(ANTHROPIC_API_KEY_ENV);
    const adminKey = yield* getEnvRedacted(ANTHROPIC_ADMIN_KEY_ENV);
    const authToken = yield* getEnvRedacted(ANTHROPIC_AUTH_TOKEN_ENV);
    const apiBaseUrl = yield* getEnv(ANTHROPIC_BASE_URL_ENV);
    if (apiKey === undefined && adminKey === undefined && authToken === undefined) {
      return yield* new AuthError({
        message: `Anthropic credentials are missing. Set ${ANTHROPIC_API_KEY_ENV} (inference) and/or ${ANTHROPIC_ADMIN_KEY_ENV} (control plane), or ${ANTHROPIC_AUTH_TOKEN_ENV}.`,
      });
    }
    return {
      type: "apiKey" as const,
      apiKey,
      adminKey,
      authToken,
      apiBaseUrl: apiBaseUrl || undefined,
      source: {
        type: "env" as const,
        details: [
          apiKey && ANTHROPIC_API_KEY_ENV,
          adminKey && ANTHROPIC_ADMIN_KEY_ENV,
          authToken && ANTHROPIC_AUTH_TOKEN_ENV,
        ]
          .filter(Boolean)
          .join(", "),
      },
    };
  }),
  environment: [
    {
      name: ANTHROPIC_API_KEY_ENV,
      required: true,
      secret: true,
      alternatives: [ANTHROPIC_ADMIN_KEY_ENV, ANTHROPIC_AUTH_TOKEN_ENV],
      description:
        "Inference API key (Messages API). At least one of ANTHROPIC_API_KEY, ANTHROPIC_ADMIN_KEY or ANTHROPIC_AUTH_TOKEN is required.",
    },
    {
      name: ANTHROPIC_ADMIN_KEY_ENV,
      required: false,
      secret: true,
      description: "Admin API key for the control-plane resources (Workspace, SpendLimit)",
    },
    {
      name: ANTHROPIC_AUTH_TOKEN_ENV,
      required: false,
      secret: true,
      description: "OAuth access token, used when no key applies to a route",
    },
    {
      name: ANTHROPIC_BASE_URL_ENV,
      required: false,
      description: "API root override (default https://api.anthropic.com)",
    },
  ],
});

/**
 * Layer that registers the Anthropic {@link AuthProvider} into the
 * {@link AuthProviders} registry.
 *
 * Auth is API-key based: `ANTHROPIC_API_KEY` for inference and
 * `ANTHROPIC_ADMIN_KEY` for the Admin API (`/v1/organizations/*`) that backs
 * the control-plane resources. Either may be stored in an Alchemy profile.
 */
export const AnthropicAuth = anthropicAuth.layer;
