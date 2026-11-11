import { DEFAULT_API_BASE_URL } from "@distilled.cloud/digitalocean/Credentials";
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

export const DIGITALOCEAN_AUTH_PROVIDER_NAME = "DigitalOcean";

// Terraform reads `DIGITALOCEAN_TOKEN`, doctl `DIGITALOCEAN_ACCESS_TOKEN`,
// distilled `DIGITALOCEAN_API_KEY`.
export const DIGITALOCEAN_TOKEN_ENV = "DIGITALOCEAN_TOKEN";
export const DIGITALOCEAN_ACCESS_TOKEN_ENV = "DIGITALOCEAN_ACCESS_TOKEN";
export const DIGITALOCEAN_API_KEY_ENV = "DIGITALOCEAN_API_KEY";
const TOKEN_ENV_NAMES = [
  DIGITALOCEAN_TOKEN_ENV,
  DIGITALOCEAN_ACCESS_TOKEN_ENV,
  DIGITALOCEAN_API_KEY_ENV,
] as const;
export const DIGITALOCEAN_API_BASE_URL_ENV = "DIGITALOCEAN_API_BASE_URL";
// The names doctl and the Terraform provider read.
export const SPACES_ACCESS_KEY_ID_ENV = "SPACES_ACCESS_KEY_ID";
export const SPACES_SECRET_ACCESS_KEY_ENV = "SPACES_SECRET_ACCESS_KEY";

export type DigitalOceanAuthConfig = StoredAuthConfig;

export type DigitalOceanResolvedCredentials = {
  type: "apiToken";
  apiToken: Redacted.Redacted<string>;
  apiBaseUrl: string;
  /** Spaces access key for the S3-compatible API; minted per deploy when absent. */
  spacesAccessKeyId?: Redacted.Redacted<string>;
  spacesSecretAccessKey?: Redacted.Redacted<string>;
  source: { type: DigitalOceanAuthConfig["method"] | "env"; details?: string };
};

const firstTokenInEnvironment = Effect.gen(function* () {
  for (const name of TOKEN_ENV_NAMES) {
    const apiToken = yield* getEnvRedacted(name);
    if (apiToken) return { name, apiToken };
  }
  return yield* AuthError.make({
    message: `DigitalOcean env credentials not found. Set ${TOKEN_ENV_NAMES.join(", ")}.`,
  });
});

const readEnvironment = Effect.gen(function* () {
  const token = yield* firstTokenInEnvironment;
  const apiBaseUrl = yield* getEnv(DIGITALOCEAN_API_BASE_URL_ENV);
  const spacesAccessKeyId = yield* getEnvRedacted(SPACES_ACCESS_KEY_ID_ENV);
  const spacesSecretAccessKey = yield* getEnvRedacted(SPACES_SECRET_ACCESS_KEY_ENV);
  return {
    type: "apiToken" as const,
    apiToken: token.apiToken,
    apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
    spacesAccessKeyId,
    spacesSecretAccessKey,
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
    {
      name: "spacesAccessKeyId",
      label: "Spaces access key id (optional; one is created per deploy when empty)",
      optional: true,
    },
    {
      name: "spacesSecretAccessKey",
      label: "Spaces secret access key",
      secret: true,
      optional: true,
    },
  ],
  toResolved: (values) => ({
    type: "apiToken",
    apiToken: storedSecret(values.apiToken) ?? Redacted.make(""),
    apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    spacesAccessKeyId: storedValueText(values.spacesAccessKeyId)
      ? Redacted.make(storedValueText(values.spacesAccessKeyId)!)
      : undefined,
    spacesSecretAccessKey: storedSecret(values.spacesSecretAccessKey),
    source: { type: "stored" },
  }),
  readEnvironment,
  environment: [
    {
      name: DIGITALOCEAN_TOKEN_ENV,
      required: true,
      secret: true,
      alternatives: [DIGITALOCEAN_ACCESS_TOKEN_ENV, DIGITALOCEAN_API_KEY_ENV],
      description: "Personal access token.",
    },
    {
      name: DIGITALOCEAN_API_BASE_URL_ENV,
      required: false,
      description: "API base URL override.",
    },
    {
      name: SPACES_ACCESS_KEY_ID_ENV,
      required: false,
      description: "Spaces access key id. Without one, a key is created for each deploy.",
    },
    {
      name: SPACES_SECRET_ACCESS_KEY_ENV,
      required: false,
      secret: true,
      description: "Spaces secret access key.",
    },
  ],
});

/**
 * Layer that registers the DigitalOcean {@link AuthProvider} into the
 * {@link AuthProviders} registry.
 *
 * Auth is a Personal Access Token from `DIGITALOCEAN_TOKEN`,
 * `DIGITALOCEAN_ACCESS_TOKEN` or `DIGITALOCEAN_API_KEY`, first set wins.
 * An optional `DIGITALOCEAN_API_BASE_URL` overrides the API root.
 */
export const DigitalOceanAuth = digitalOceanAuth.layer;
