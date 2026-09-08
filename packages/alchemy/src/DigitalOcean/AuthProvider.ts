import { DEFAULT_API_BASE_URL } from "@distilled.cloud/digitalocean/Credentials";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AuthError } from "../Auth/AuthProvider.ts";
import { getEnv, getEnvRedacted } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

export const DIGITALOCEAN_AUTH_PROVIDER_NAME = "DigitalOcean";

// The Terraform provider reads `DIGITALOCEAN_TOKEN`; `doctl` reads
// `DIGITALOCEAN_ACCESS_TOKEN`. The first name wins when both are set.
export const DIGITALOCEAN_TOKEN_ENV = "DIGITALOCEAN_TOKEN";
export const DIGITALOCEAN_ACCESS_TOKEN_ENV = "DIGITALOCEAN_ACCESS_TOKEN";
export const DIGITALOCEAN_API_BASE_URL_ENV = "DIGITALOCEAN_API_BASE_URL";

export type DigitalOceanAuthConfig = StoredAuthConfig;

export type DigitalOceanResolvedCredentials = {
  type: "apiToken";
  apiToken: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: DigitalOceanAuthConfig["method"] | "env"; details?: string };
};

const readEnvironment = Effect.gen(function* () {
  const fromToken = yield* getEnvRedacted(DIGITALOCEAN_TOKEN_ENV);
  const fromAccessToken = fromToken
    ? undefined
    : yield* getEnvRedacted(DIGITALOCEAN_ACCESS_TOKEN_ENV);
  const apiToken = fromToken ?? fromAccessToken;
  if (!apiToken) {
    return yield* new AuthError({
      message: `DigitalOcean CI credentials not found. Set ${DIGITALOCEAN_TOKEN_ENV} or ${DIGITALOCEAN_ACCESS_TOKEN_ENV}.`,
    });
  }
  const apiBaseUrl = yield* getEnv(DIGITALOCEAN_API_BASE_URL_ENV);
  const tokenName = fromToken
    ? DIGITALOCEAN_TOKEN_ENV
    : DIGITALOCEAN_ACCESS_TOKEN_ENV;
  return {
    type: "apiToken" as const,
    apiToken,
    apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
    source: {
      type: "env" as const,
      details: apiBaseUrl
        ? `${tokenName}, ${DIGITALOCEAN_API_BASE_URL_ENV}`
        : tokenName,
    },
  };
});

const digitalOceanAuth =
  makeStoredAuthProvider<DigitalOceanResolvedCredentials>({
    provider: DIGITALOCEAN_AUTH_PROVIDER_NAME,
    fields: [
      {
        name: "apiToken",
        label: "DigitalOcean Personal Access Token",
        secret: true,
      },
      {
        name: "apiBaseUrl",
        label: "DigitalOcean API base URL",
        optional: true,
        placeholder: DEFAULT_API_BASE_URL,
      },
    ],
    toResolved: (values) => ({
      type: "apiToken",
      apiToken: storedSecret(values.apiToken) ?? Redacted.make(""),
      apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
      source: { type: "stored" },
    }),
    readEnvironment,
    environment: [
      {
        name: DIGITALOCEAN_TOKEN_ENV,
        required: true,
        secret: true,
        alternatives: [DIGITALOCEAN_ACCESS_TOKEN_ENV],
        description: "Personal access token; doctl sets the alternative name.",
      },
      {
        name: DIGITALOCEAN_API_BASE_URL_ENV,
        required: false,
        description: "API base URL override.",
      },
    ],
  });

/**
 * Layer that registers the DigitalOcean {@link AuthProvider} into the
 * {@link AuthProviders} registry.
 *
 * Auth is a Personal Access Token (`DIGITALOCEAN_TOKEN`, or
 * `DIGITALOCEAN_ACCESS_TOKEN` as set by `doctl`). An optional
 * `DIGITALOCEAN_API_BASE_URL` overrides the API root.
 */
export const DigitalOceanAuth = digitalOceanAuth.layer;
