import * as Context from "effect/Context";

/**
 * Default name of the state-store Worker deployed by
 * `Cloudflare.state()` / `alchemy provider cloudflare bootstrap`.
 */
export const STATE_STORE_SCRIPT_NAME = "alchemy-state-store" as const;

/** Historical bearer-token secret name for the default state store. */
export const AuthTokenSecretName = "AlchemyStateStoreToken" as const;

/** Historical encryption-key secret name for the default state store. */
export const EncryptionKeySecretName = "AlchemyStateStoreEncryptionKey" as const;

/**
 * The physical name of the state-store Worker for the current
 * deploy, as a `Context.Reference` so it can flow from
 * `Cloudflare.state({ workerName })` (or `bootstrap({ workerName })`)
 * into the state-store stack — the Worker resource in `Api.ts` and
 * the Secrets Store secrets in `Token.ts` — without those modules
 * taking constructor parameters (their default exports must stay
 * statically analyzable for the worker bundler).
 *
 * The default keeps every un-parameterized consumer (including the
 * re-evaluated module inside the deployed worker bundle, where the
 * name is irrelevant) on the historical `alchemy-state-store`
 * identity.
 */
export const StateStoreWorkerName = Context.Reference<string>(
  "Alchemy/Cloudflare/StateStoreWorkerName",
  { defaultValue: () => STATE_STORE_SCRIPT_NAME },
);

/**
 * Cloudflare Secrets Store secret names only allow `[A-Za-z0-9_]`.
 * Map dashes to underscores. Worker names are lowercase,
 * so reserve `U` for a literal underscore and `Z<hex>Z` for other characters.
 * Escaping those uppercase markers too keeps distinct names distinct.
 */
const sanitizeSecretName = (name: string) =>
  name
    .replace(/[^a-z0-9-]/g, (char) => (char === "_" ? "U" : `Z${char.charCodeAt(0).toString(16)}Z`))
    .replace(/-/g, "_");

/**
 * Per-store name of the bearer-token secret in the account Secrets
 * Store. The default store keeps the historical un-suffixed name so
 * existing deployments keep resolving their secret; named stores get
 * a suffixed name so each store has its own credential authority —
 * one store's bearer token must never authenticate against another.
 */
export const authTokenSecretName = (workerName: string) =>
  workerName === STATE_STORE_SCRIPT_NAME
    ? AuthTokenSecretName
    : `${AuthTokenSecretName}_${sanitizeSecretName(workerName)}`;

/**
 * Per-store name of the state-encryption-key secret. Same suffixing
 * rule as {@link authTokenSecretName}: each store encrypts its state
 * with its own key, so credentials for one store cannot decrypt
 * another store's state.
 */
export const encryptionKeySecretName = (workerName: string) =>
  workerName === STATE_STORE_SCRIPT_NAME
    ? EncryptionKeySecretName
    : `${EncryptionKeySecretName}_${sanitizeSecretName(workerName)}`;
