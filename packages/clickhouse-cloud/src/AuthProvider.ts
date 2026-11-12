import { DEFAULT_API_BASE_URL } from "@distilled.cloud/clickhouse-cloud/Credentials";
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
 * look up the ClickHouse Cloud AuthProvider from inside provider Layers.
 */
export const CLICKHOUSE_CLOUD_AUTH_PROVIDER_NAME = "ClickHouseCloud";

export type ClickHouseCloudAuthConfig = StoredAuthConfig;

/**
 * Resolved ClickHouse Cloud credentials.
 *
 * The ClickHouse Cloud API authenticates every request with HTTP Basic: an
 * API key ID as the username and its secret as the password. Every
 * operation is scoped to one organization; an API key belongs to exactly
 * one, so `organizationId` is optional and is looked up from the key when
 * it is not configured.
 */
export interface ClickHouseCloudResolvedCredentials {
  type: "apiKey";
  /** API key ID, the Basic-auth username. */
  keyId: string;
  /** API key secret, the Basic-auth password. */
  keySecret: Redacted.Redacted<string>;
  /** Organization the key belongs to, when configured. */
  organizationId: string | undefined;
  /** API origin. */
  apiBaseUrl: string;
  source: { type: ClickHouseCloudAuthConfig["method"] | "env"; details?: string };
}

const nonEmpty = (value: string | undefined) =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

const readEnvironment = Effect.gen(function* () {
  // The Terraform provider reads CLICKHOUSE_CLOUD_API_KEY / _API_SECRET; that
  // pair is the fallback, and a key ID is never sent with the other pair's
  // secret.
  const primaryId = nonEmpty(yield* getEnv("CLICKHOUSE_CLOUD_API_KEY_ID"));
  const primarySecret = yield* getEnvRedacted("CLICKHOUSE_CLOUD_API_KEY_SECRET");
  const fallbackId = nonEmpty(yield* getEnv("CLICKHOUSE_CLOUD_API_KEY"));
  const fallbackSecret = yield* getEnvRedacted("CLICKHOUSE_CLOUD_API_SECRET");
  const pair =
    primaryId !== undefined && primarySecret !== undefined
      ? {
          keyId: primaryId,
          keySecret: primarySecret,
          details: "CLICKHOUSE_CLOUD_API_KEY_ID/CLICKHOUSE_CLOUD_API_KEY_SECRET",
        }
      : fallbackId !== undefined && fallbackSecret !== undefined
        ? {
            keyId: fallbackId,
            keySecret: fallbackSecret,
            details: "CLICKHOUSE_CLOUD_API_KEY/CLICKHOUSE_CLOUD_API_SECRET",
          }
        : undefined;
  if (pair === undefined || Redacted.value(pair.keySecret).trim().length === 0) {
    return yield* AuthError.make({
      message:
        "ClickHouse Cloud CI credentials not found. Set CLICKHOUSE_CLOUD_API_KEY_ID and CLICKHOUSE_CLOUD_API_KEY_SECRET.",
    });
  }
  return {
    type: "apiKey" as const,
    keyId: pair.keyId,
    keySecret: Redacted.make(Redacted.value(pair.keySecret).trim()),
    organizationId: nonEmpty(yield* getEnv("CLICKHOUSE_CLOUD_ORGANIZATION_ID")),
    apiBaseUrl: nonEmpty(yield* getEnv("CLICKHOUSE_CLOUD_API_URL")) ?? DEFAULT_API_BASE_URL,
    source: { type: "env" as const, details: pair.details },
  } satisfies ClickHouseCloudResolvedCredentials;
});

const clickHouseCloudAuth = makeStoredAuthProvider<ClickHouseCloudResolvedCredentials>({
  provider: CLICKHOUSE_CLOUD_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "keyId",
      label: "ClickHouse Cloud API Key ID",
      description:
        "Create a key in the ClickHouse Cloud console (Organization > API keys). Give it the Admin role to manage services, keys and roles.",
      validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
    },
    {
      name: "keySecret",
      label: "ClickHouse Cloud API Key Secret",
      description: "Shown once, when the key is created.",
      secret: true,
      validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
    },
    {
      name: "organizationId",
      label: "ClickHouse Cloud Organization ID",
      description:
        "Optional: looked up from the key when blank, since a key belongs to one organization.",
      optional: true,
    },
    {
      name: "apiBaseUrl",
      label: "ClickHouse Cloud API URL",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values, source) => ({
    type: "apiKey",
    keyId: (storedValueText(values.keyId) ?? "").trim(),
    keySecret: storedSecret(values.keySecret) ?? Redacted.make(""),
    organizationId: nonEmpty(storedValueText(values.organizationId)),
    apiBaseUrl: nonEmpty(storedValueText(values.apiBaseUrl)) ?? DEFAULT_API_BASE_URL,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "CLICKHOUSE_CLOUD_API_KEY_ID",
      required: true,
      alternatives: ["CLICKHOUSE_CLOUD_API_KEY"],
      description: "API key ID.",
    },
    {
      name: "CLICKHOUSE_CLOUD_API_KEY_SECRET",
      required: true,
      secret: true,
      alternatives: ["CLICKHOUSE_CLOUD_API_SECRET"],
      description: "API key secret.",
    },
    {
      name: "CLICKHOUSE_CLOUD_ORGANIZATION_ID",
      required: false,
      description: "Organization ID; looked up from the key when unset.",
    },
    {
      name: "CLICKHOUSE_CLOUD_API_URL",
      required: false,
      description: `API origin. Defaults to ${DEFAULT_API_BASE_URL}.`,
    },
  ],
});

/**
 * Layer that registers the ClickHouse Cloud AuthProvider into the
 * AuthProviders registry when built. Included in
 * `ClickHouseCloud.providers()` so `alchemy profile edit` can configure it.
 */
export const ClickHouseCloudAuth = clickHouseCloudAuth.layer;

/** Schema of ClickHouse Cloud's inline API-key values. */
export const ClickHouseCloudStoredCredentials = clickHouseCloudAuth.storedSchema;
export type ClickHouseCloudStoredCredentials = typeof ClickHouseCloudStoredCredentials.Type;
