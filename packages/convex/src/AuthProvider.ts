import { DEFAULT_API_BASE_URL } from "@distilled.cloud/convex/Credentials";
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

/**
 * Canonical name registered in the AuthProviders registry. Use this key to
 * look up the Convex AuthProvider from inside provider Layers.
 */
export const CONVEX_AUTH_PROVIDER_NAME = "Convex";

export type ConvexAuthConfig = StoredAuthConfig;

/**
 * Resolved Convex Management API credentials. `teamId` is optional because it
 * is discovered from the token when omitted.
 */
export interface ConvexResolvedCredentials {
  type: "accessToken";
  accessToken: Redacted.Redacted<string>;
  apiBaseUrl: string;
  teamId: string | undefined;
  source: { type: ConvexAuthConfig["method"] | "env"; details?: string };
}

export const readEnvironment = Effect.gen(function* () {
  const token = yield* getEnvRedacted("CONVEX_ACCESS_TOKEN");
  if (token === undefined || Redacted.value(token).trim().length === 0) {
    return yield* AuthError.make({
      message: "Convex CI credentials not found. Set CONVEX_ACCESS_TOKEN.",
    });
  }
  return {
    type: "accessToken" as const,
    accessToken: Redacted.make(Redacted.value(token).trim()),
    apiBaseUrl: (yield* getEnv("CONVEX_API_BASE_URL")) ?? DEFAULT_API_BASE_URL,
    teamId: yield* getEnv("CONVEX_TEAM_ID"),
    source: { type: "env" as const, details: "CONVEX_ACCESS_TOKEN" },
  } satisfies ConvexResolvedCredentials;
});

const convexAuth = makeStoredAuthProvider<ConvexResolvedCredentials>({
  provider: CONVEX_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "accessToken",
      label: "Convex Team Access Token",
      description:
        "Create one in your team settings. A token belongs to the person who created it, so Convex recommends a service account.",
      secret: true,
      validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
    },
    {
      name: "teamId",
      label: "Convex Team ID",
      description: "Defaults to the token's team.",
      optional: true,
    },
  ],
  toResolved: (values, source) => ({
    type: "accessToken",
    accessToken: storedSecret(values.accessToken) ?? Redacted.make(""),
    apiBaseUrl: DEFAULT_API_BASE_URL,
    teamId: storedValueText(values.teamId),
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "CONVEX_ACCESS_TOKEN",
      required: true,
      secret: true,
      description: "Convex team access token.",
    },
    {
      name: "CONVEX_TEAM_ID",
      required: false,
      description: "Team ID; defaults to the token's team.",
    },
    {
      name: "CONVEX_API_BASE_URL",
      required: false,
      description: "Management API base URL override.",
    },
  ],
});

/**
 * Layer that registers the Convex AuthProvider into the AuthProviders
 * registry when built. Included in `Convex.providers()` so the alchemy CLI
 * (`alchemy profile edit`) can configure it.
 */
export const ConvexAuth = convexAuth.layer;

/** Schema of Convex's stored token values. */
export const ConvexStoredCredentials = convexAuth.storedSchema;
export type ConvexStoredCredentials = typeof ConvexStoredCredentials.Type;
