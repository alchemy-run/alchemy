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

// The Terraform provider reads `DIGITALOCEAN_TOKEN`, `doctl` reads
// `DIGITALOCEAN_ACCESS_TOKEN`, and the distilled SDK also reads
// `DIGITALOCEAN_API_KEY`. The first name set wins.
export const DIGITALOCEAN_TOKEN_ENV = "DIGITALOCEAN_TOKEN";
export const DIGITALOCEAN_ACCESS_TOKEN_ENV = "DIGITALOCEAN_ACCESS_TOKEN";
export const DIGITALOCEAN_API_KEY_ENV = "DIGITALOCEAN_API_KEY";
const TOKEN_ENV_NAMES = [
  DIGITALOCEAN_TOKEN_ENV,
  DIGITALOCEAN_ACCESS_TOKEN_ENV,
  DIGITALOCEAN_API_KEY_ENV,
] as const;
export const DIGITALOCEAN_API_BASE_URL_ENV = "DIGITALOCEAN_API_BASE_URL";

export type DigitalOceanAuthConfig = StoredAuthConfig;

export type DigitalOceanResolvedCredentials = {
  type: "apiToken";
  apiToken: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: DigitalOceanAuthConfig["method"] | "env"; details?: string };
};

const firstTokenInEnvironment = Effect.fn(function* () {
  for (const name of TOKEN_ENV_NAMES) {
    const apiToken = yield* getEnvRedacted(name);
    if (apiToken) return { name, apiToken };
  }
  return yield* AuthError.make({
    message: `DigitalOcean env credentials not found. Set ${TOKEN_ENV_NAMES.join(", ")}.`,
  });
});

const readEnvironment = Effect.gen(function* () {
  const token = yield* firstTokenInEnvironment();
  const apiBaseUrl = yield* getEnv(DIGITALOCEAN_API_BASE_URL_ENV);
  return {
    type: "apiToken" as const,
    apiToken: token.apiToken,
    apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
    source: {
      type: "env" as const,
      details: apiBaseUrl ? `${token.name}, ${DIGITALOCEAN_API_BASE_URL_ENV}` : token.name,
    },
  };
});

const digitalOceanAuth = makeStoredAuthProvider<DigitalOceanResolvedCredentials>({
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
      alternatives: [DIGITALOCEAN_ACCESS_TOKEN_ENV, DIGITALOCEAN_API_KEY_ENV],
      description: "Personal access token; doctl and the SDK set the alternative names.",
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
 * Auth is a Personal Access Token (`DIGITALOCEAN_TOKEN`,
 * `DIGITALOCEAN_ACCESS_TOKEN` as set by `doctl`, or `DIGITALOCEAN_API_KEY`).
 * An optional `DIGITALOCEAN_API_BASE_URL` overrides the API root.
 */
export const DigitalOceanAuth = digitalOceanAuth.layer;
