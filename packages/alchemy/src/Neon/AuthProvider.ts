import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { getEnvRedactedRequired } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

export const NEON_AUTH_PROVIDER_NAME = "Neon";

export type NeonAuthConfig = StoredAuthConfig;

export type NeonResolvedCredentials = {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  source: { type: NeonAuthConfig["method"] | "env"; details?: string };
};

const neonAuth = makeStoredAuthProvider<NeonResolvedCredentials>({
  provider: NEON_AUTH_PROVIDER_NAME,
  storageKey: "neon-stored",
  fields: [{ name: "apiKey", label: "Neon API Key", secret: true }],
  toResolved: (values) => ({
    type: "apiKey",
    apiKey: Redacted.make(values.apiKey!),
    source: { type: "stored" },
  }),
  readEnvironment: getEnvRedactedRequired("NEON_API_KEY").pipe(
    Effect.map((apiKey) => ({
      type: "apiKey" as const,
      apiKey,
      source: { type: "env" as const },
    })),
  ),
  environment: [
    {
      name: "NEON_API_KEY",
      required: true,
      secret: true,
    },
  ],
});

/**
 * Layer that registers the Neon {@link AuthProvider} into the
 * {@link AuthProviders} registry.
 */
export const NeonAuth = neonAuth.layer;

/** Schema of the stored Neon credential file (flat field record). */
export const NeonStoredCredentials = neonAuth.storedSchema;
export type NeonStoredCredentials = typeof NeonStoredCredentials.Type;
