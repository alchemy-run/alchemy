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

/**
 * Canonical name registered in {@link AuthProviders}. Use this key to look
 * up the OpenAI {@link AuthProvider} from inside provider Layers.
 */
export const OPENAI_AUTH_PROVIDER_NAME = "OpenAI";

/** Inference/platform API key (usually a project key, `sk-proj-…`). */
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
/** Admin API key (`sk-admin-…`) for the `/organization/*` control plane. */
export const OPENAI_ADMIN_KEY_ENV = "OPENAI_ADMIN_KEY";
/** Sent as the `OpenAI-Organization` header when set. */
export const OPENAI_ORGANIZATION_ENV = "OPENAI_ORGANIZATION";

export type OpenAIAuthConfig = StoredAuthConfig;

/**
 * Resolved in-memory OpenAI credentials. Either key may be absent: inference
 * operations need `apiKey`, Admin API operations (projects, service accounts,
 * rate limits) need `adminKey`. The SDK fails with a typed
 * `MissingCredentials` error naming the variable when the key an operation
 * needs is not configured.
 */
export interface OpenAIResolvedCredentials {
  readonly apiKey: Redacted.Redacted<string> | undefined;
  readonly adminKey: Redacted.Redacted<string> | undefined;
  readonly organization: string | undefined;
  readonly source: { readonly type: "stored" | "env" };
}

const nonEmpty = (value: Redacted.Redacted<string> | undefined) =>
  value !== undefined && Redacted.value(value).length > 0 ? value : undefined;

const missingKeys = () =>
  new AuthError({
    message: `OpenAI: configure an API key (${OPENAI_API_KEY_ENV}), an Admin key (${OPENAI_ADMIN_KEY_ENV}), or both.`,
  });

const openAIAuth = makeStoredAuthProvider<OpenAIResolvedCredentials>({
  provider: OPENAI_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiKey",
      label: "OpenAI API key (sk-proj-…)",
      description: "Used for inference (Responses, Chat Completions, …).",
      secret: true,
      optional: true,
    },
    {
      name: "adminKey",
      label: "OpenAI Admin key (sk-admin-…)",
      description: "Used to manage projects, service accounts and rate limits.",
      secret: true,
      optional: true,
    },
    {
      name: "organization",
      label: "OpenAI organization ID (org-…)",
      optional: true,
    },
  ],
  // At least one key is required — an empty profile can call nothing.
  complete: (values) =>
    storedValueText(values.apiKey) || storedValueText(values.adminKey)
      ? Effect.succeed(values)
      : Effect.fail(missingKeys()),
  toResolved: (values) => ({
    apiKey: nonEmpty(storedSecret(values.apiKey)),
    adminKey: nonEmpty(storedSecret(values.adminKey)),
    organization: storedValueText(values.organization) || undefined,
    source: { type: "stored" },
  }),
  readEnvironment: Effect.gen(function* () {
    const apiKey = nonEmpty(yield* getEnvRedacted(OPENAI_API_KEY_ENV));
    const adminKey = nonEmpty(yield* getEnvRedacted(OPENAI_ADMIN_KEY_ENV));
    if (apiKey === undefined && adminKey === undefined) return yield* missingKeys();
    const organization = (yield* getEnv(OPENAI_ORGANIZATION_ENV)) || undefined;
    return {
      apiKey,
      adminKey,
      organization,
      source: { type: "env" as const },
    } satisfies OpenAIResolvedCredentials;
  }),
  environment: [
    {
      name: OPENAI_API_KEY_ENV,
      required: true,
      secret: true,
      alternatives: [OPENAI_ADMIN_KEY_ENV],
      description: `Inference API key. Set ${OPENAI_ADMIN_KEY_ENV} (an sk-admin-… key) as well, or instead, to manage projects, service accounts and rate limits.`,
    },
    {
      name: OPENAI_ORGANIZATION_ENV,
      required: false,
      description: "Organization ID sent as the OpenAI-Organization header.",
    },
    {
      name: "OPENAI_BASE_URL",
      required: false,
      description: "API base URL override.",
    },
  ],
});

/**
 * Layer that registers the OpenAI {@link AuthProvider} into the
 * {@link AuthProviders} registry. Credentials resolve from the environment
 * (`OPENAI_API_KEY` and/or `OPENAI_ADMIN_KEY`) when present, otherwise from
 * the selected Alchemy profile.
 */
export const OpenAIAuth = openAIAuth.layer;
