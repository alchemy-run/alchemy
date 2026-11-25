import { DEFAULT_API_BASE_URL } from "@distilled.cloud/mux/Credentials";
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

export const MUX_AUTH_PROVIDER_NAME = "Mux";

export type MuxAuthConfig = StoredAuthConfig;

/** A Mux access token, scoped to one Mux environment. */
export interface MuxResolvedCredentials {
  tokenId: string;
  tokenSecret: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: MuxAuthConfig["method"] | "env"; details?: string };
}

const readEnvironment = Effect.gen(function* () {
  const tokenId = yield* getEnv("MUX_TOKEN_ID");
  const tokenSecret = yield* getEnvRedacted("MUX_TOKEN_SECRET");
  if (!tokenId || !tokenSecret) {
    return yield* AuthError.make({
      message: "Mux CI credentials not found. Set MUX_TOKEN_ID and MUX_TOKEN_SECRET.",
    });
  }
  return {
    tokenId,
    tokenSecret,
    apiBaseUrl: (yield* getEnv("MUX_BASE_URL")) ?? DEFAULT_API_BASE_URL,
    source: { type: "env" as const },
  };
});

const muxAuth = makeStoredAuthProvider<MuxResolvedCredentials>({
  provider: MUX_AUTH_PROVIDER_NAME,
  fields: [
    { name: "tokenId", label: "Mux Access Token ID" },
    { name: "tokenSecret", label: "Mux Access Token Secret", secret: true },
  ],
  toResolved: (values, source) => ({
    tokenId: storedValueText(values.tokenId) ?? "",
    tokenSecret: storedSecret(values.tokenSecret) ?? Redacted.make(""),
    apiBaseUrl: DEFAULT_API_BASE_URL,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "MUX_TOKEN_ID",
      required: true,
      description: "Access token ID, from Settings > Access Tokens in the Mux dashboard.",
    },
    { name: "MUX_TOKEN_SECRET", required: true, secret: true, description: "Access token secret." },
    { name: "MUX_BASE_URL", required: false, description: "API origin override." },
  ],
});

/**
 * Registers the Mux AuthProvider so `alchemy profile edit` can configure it.
 * Include it in the Mux `providers()` layer.
 */
export const MuxAuth = muxAuth.layer;

/** Schema of Mux's stored access-token values. */
export const MuxStoredCredentials = muxAuth.storedSchema;
export type MuxStoredCredentials = typeof MuxStoredCredentials.Type;
