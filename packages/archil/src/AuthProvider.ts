import { DEFAULT_REGION, REGIONS } from "@distilled.cloud/archil/Credentials";
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
 * look up the Archil AuthProvider from inside provider Layers.
 */
export const ARCHIL_AUTH_PROVIDER_NAME = "Archil";

export type ArchilAuthConfig = StoredAuthConfig;

/**
 * Resolved Archil credentials.
 *
 * Archil's control plane authenticates with account API keys (created in
 * the console). Every disk, sandbox and image
 * lives in one region, which picks the control plane and S3 endpoints.
 */
export interface ArchilResolvedCredentials {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  /** Archil region id, e.g. `aws-us-east-1`. */
  region: string;
  /**
   * Archil organization id. Only needed to scope bucket policies on
   * bring-your-own-bucket disks to your organization.
   */
  organization: string | undefined;
  source: { type: ArchilAuthConfig["method"] | "env"; details?: string };
}

const validateRegion = (value: string) =>
  value in REGIONS ? undefined : `One of ${Object.keys(REGIONS).join(", ")}`;

const readEnvironment = Effect.gen(function* () {
  const apiKey = yield* getEnvRedacted("ARCHIL_API_KEY");
  if (apiKey === undefined || Redacted.value(apiKey).trim().length === 0) {
    return yield* AuthError.make({
      message: "Archil CI credentials not found. Set ARCHIL_API_KEY.",
    });
  }
  return {
    type: "apiKey" as const,
    apiKey: Redacted.make(Redacted.value(apiKey).trim()),
    region: (yield* getEnv("ARCHIL_REGION")) ?? DEFAULT_REGION,
    organization: yield* getEnv("ARCHIL_ORGANIZATION"),
    source: { type: "env" as const, details: "ARCHIL_API_KEY" },
  } satisfies ArchilResolvedCredentials;
});

const archilAuth = makeStoredAuthProvider<ArchilResolvedCredentials>({
  provider: ARCHIL_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiKey",
      label: "Archil API Key",
      description: "Create one at https://console.archil.com (API Keys). It starts with `key-`.",
      secret: true,
      validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
    },
    {
      name: "region",
      label: "Archil Region",
      description: `Region your disks and sandboxes live in. Defaults to ${DEFAULT_REGION}.`,
      optional: true,
      validate: (value) => (value.trim().length === 0 ? undefined : validateRegion(value.trim())),
    },
    {
      name: "organization",
      label: "Archil Organization ID",
      description:
        "Only needed for disks on your own S3 bucket: scopes the bucket policy to your organization.",
      optional: true,
    },
  ],
  toResolved: (values, source) => ({
    type: "apiKey",
    apiKey: storedSecret(values.apiKey) ?? Redacted.make(""),
    region: storedValueText(values.region) || DEFAULT_REGION,
    organization: storedValueText(values.organization) || undefined,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "ARCHIL_API_KEY",
      required: true,
      secret: true,
      description: "Archil API key.",
    },
    {
      name: "ARCHIL_REGION",
      required: false,
      description: `Archil region id. Defaults to ${DEFAULT_REGION}.`,
    },
    {
      name: "ARCHIL_ORGANIZATION",
      required: false,
      description: "Archil organization id, for bring-your-own-bucket disk policies.",
    },
  ],
});

/**
 * Layer that registers the Archil AuthProvider into the AuthProviders
 * registry when built. Included in `Archil.providers()` so the alchemy CLI
 * (`alchemy profile edit`) can configure it.
 */
export const ArchilAuth = archilAuth.layer;

/** Schema of Archil's inline API-key values. */
export const ArchilStoredCredentials = archilAuth.storedSchema;
export type ArchilStoredCredentials = typeof ArchilStoredCredentials.Type;
