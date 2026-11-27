import { DEFAULT_API_BASE_URL } from "@distilled.cloud/coolify/Credentials";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const COOLIFY_AUTH_PROVIDER_NAME = "Coolify";
export const COOLIFY_TOKEN_ENV = "COOLIFY_TOKEN";
export const COOLIFY_API_BASE_URL_ENV = "COOLIFY_API_BASE_URL";

export type CoolifyAuthConfig = StoredAuthConfig;

/** Resolved Coolify credentials: an API token and the instance's API base URL. */
export interface CoolifyResolvedCredentials {
  type: "token";
  token: Redacted.Redacted<string>;
  /** API base URL, always ending in `/api/v1`. */
  apiBaseUrl: string;
  source: { type: CoolifyAuthConfig["method"] | "env"; details?: string };
}

/**
 * Normalize an instance URL to its API base. Self-hosted users usually know
 * their dashboard URL (`https://coolify.example.com`), while the API lives
 * under `/api/v1`, so both forms are accepted.
 */
export const normalizeApiBaseUrl = (raw: string | undefined): string => {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return DEFAULT_API_BASE_URL;
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
};

const readEnvironment = Effect.gen(function* () {
  const token = yield* getEnvRedacted(COOLIFY_TOKEN_ENV);
  if (!token) {
    return yield* AuthError.make({
      message: `Coolify CI credentials not found. Set ${COOLIFY_TOKEN_ENV}.`,
    });
  }
  const apiBaseUrl = normalizeApiBaseUrl(yield* getEnv(COOLIFY_API_BASE_URL_ENV));
  return {
    type: "token" as const,
    token,
    apiBaseUrl,
    source: { type: "env" as const, details: COOLIFY_TOKEN_ENV },
  } satisfies CoolifyResolvedCredentials;
});

const coolifyAuth = makeStoredAuthProvider<CoolifyResolvedCredentials>({
  provider: COOLIFY_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "token",
      label: "Coolify API token (Keys & Tokens → API tokens)",
      secret: true,
    },
    {
      name: "apiBaseUrl",
      label: "Coolify instance URL (e.g. https://coolify.example.com)",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values, source) => ({
    type: "token",
    token: storedSecret(values.token) ?? Redacted.make(""),
    apiBaseUrl: normalizeApiBaseUrl(storedValueText(values.apiBaseUrl)),
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: COOLIFY_TOKEN_ENV,
      required: true,
      secret: true,
      description:
        "Coolify API token with the `read`, `write`, `deploy` and `delete` permissions (without `delete`, deploys work but destroy fails). Add `read:sensitive` to read database passwords and connection URLs back.",
    },
    {
      name: COOLIFY_API_BASE_URL_ENV,
      required: false,
      description:
        "Instance URL of a self-hosted Coolify (`https://coolify.example.com` or `…/api/v1`). Defaults to Coolify Cloud.",
    },
  ],
});

/**
 * Layer that registers the Coolify {@link AuthProvider} into the
 * {@link AuthProviders} registry. Include it in the Coolify `providers()`
 * layer so `alchemy profile edit` can configure it.
 */
export const CoolifyAuth = coolifyAuth.layer;

/** Schema of Coolify's inline static-token values. */
export const CoolifyStoredCredentials = coolifyAuth.storedSchema;
export type CoolifyStoredCredentials = typeof CoolifyStoredCredentials.Type;
