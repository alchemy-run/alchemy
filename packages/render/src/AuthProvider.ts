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

export const RENDER_AUTH_PROVIDER_NAME = "Render";
export const DEFAULT_API_BASE_URL = "https://api.render.com/v1";

export type RenderAuthConfig = StoredAuthConfig;

export interface RenderResolvedCredentials {
  readonly apiKey: Redacted.Redacted<string>;
  readonly ownerId?: string;
  readonly apiBaseUrl: string;
  readonly source: {
    readonly type: RenderAuthConfig["method"] | "env";
    readonly details?: string;
  };
}

const normalizeBaseUrl = (url: string | undefined): string =>
  (url && url.trim().length > 0 ? url.trim() : DEFAULT_API_BASE_URL).replace(/\/+$/, "");

const readEnvironment = Effect.gen(function* () {
  const apiKey =
    (yield* getEnvRedacted("RENDER_API_KEY")) ?? (yield* getEnvRedacted("RENDER_TOKEN"));
  if (!apiKey || Redacted.value(apiKey).trim().length === 0) {
    return yield* AuthError.make({
      message: "Render credentials not found. Set RENDER_API_KEY or RENDER_TOKEN.",
    });
  }
  const ownerIdRaw = yield* getEnv("RENDER_OWNER_ID");
  const ownerId = ownerIdRaw && ownerIdRaw.trim().length > 0 ? ownerIdRaw.trim() : undefined;
  const apiBaseUrl = normalizeBaseUrl(yield* getEnv("RENDER_API_BASE_URL"));
  return {
    apiKey,
    ownerId,
    apiBaseUrl,
    source: { type: "env" as const },
  } satisfies RenderResolvedCredentials;
});

const renderAuth = makeStoredAuthProvider<RenderResolvedCredentials>({
  provider: RENDER_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiKey",
      label: "Render API Key",
      secret: true,
    },
    {
      name: "ownerId",
      label: "Render Workspace / Owner ID (optional if API key has one workspace)",
      optional: true,
    },
    {
      name: "apiBaseUrl",
      label: "Render API Base URL",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values, source) => {
    const apiKey = storedSecret(values.apiKey) ?? Redacted.make("");
    const ownerText = storedValueText(values.ownerId);
    const ownerId = ownerText && ownerText.trim().length > 0 ? ownerText.trim() : undefined;
    const apiBaseUrl = normalizeBaseUrl(storedValueText(values.apiBaseUrl));
    return {
      apiKey,
      ownerId,
      apiBaseUrl,
      source: { type: source },
    };
  },
  readEnvironment,
  environment: [
    {
      name: "RENDER_API_KEY",
      required: true,
      secret: true,
      alternatives: ["RENDER_TOKEN"],
      description: "Render REST API key created in Account Settings.",
    },
    {
      name: "RENDER_OWNER_ID",
      required: false,
      description:
        "Workspace or user owner ID (`tea-...` / `usr-...`). Auto-detected when the token has a single owner.",
    },
    {
      name: "RENDER_API_BASE_URL",
      required: false,
      description: "Optional Render API v1 base URL override.",
    },
  ],
});

/**
 * Layer that registers the Render `AuthProvider` into Alchemy's
 * `AuthProviders` registry. Included automatically in `Render.providers()`.
 */
export const RenderAuth = renderAuth.layer;

/** Schema of Render's stored profile credentials. */
export const RenderStoredCredentials = renderAuth.storedSchema;
export type RenderStoredCredentials = typeof RenderStoredCredentials.Type;
