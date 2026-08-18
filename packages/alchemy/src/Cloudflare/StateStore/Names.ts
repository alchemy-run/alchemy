import * as Context from "effect/Context";

/**
 * Default name of the state-store Worker deployed by
 * `Cloudflare.state()` / `alchemy bootstrap cloudflare`.
 */
export const STATE_STORE_SCRIPT_NAME = "alchemy-state-store" as const;

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
 * Worker names allow dashes, so fold anything else to `_` when a
 * worker name is embedded in a secret name.
 */
const sanitizeSecretName = (name: string) =>
  name.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * Per-store name of the bearer-token secret in the account Secrets
 * Store. The default store keeps the historical un-suffixed name so
 * existing deployments keep resolving their secret; named stores get
 * a suffixed name so each store has its own credential authority —
 * one store's bearer token must never authenticate against another.
 */
export const authTokenSecretName = (workerName: string) =>
  workerName === STATE_STORE_SCRIPT_NAME
    ? "AlchemyStateStoreToken"
    : `AlchemyStateStoreToken_${sanitizeSecretName(workerName)}`;

/**
 * Per-store name of the state-encryption-key secret. Same suffixing
 * rule as {@link authTokenSecretName}: each store encrypts its state
 * with its own key, so credentials for one store cannot decrypt
 * another store's state.
 */
export const encryptionKeySecretName = (workerName: string) =>
  workerName === STATE_STORE_SCRIPT_NAME
    ? "AlchemyStateStoreEncryptionKey"
    : `AlchemyStateStoreEncryptionKey_${sanitizeSecretName(workerName)}`;
