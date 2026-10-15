import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CredentialsStoreService } from "../../Auth/Credentials.ts";

/**
 * Filename (under `~/.alchemy/credentials/{profile}/`) used to cache the
 * Cloudflare-deployed HTTP state store's endpoint + bearer token.
 *
 * Kept in this leaf module (rather than `StateStore/State.ts`) so the
 * Cloudflare auth provider can invalidate the cache on
 * `profile edit` / provider logout without importing the heavy state-store
 * module and creating an import cycle
 * (`StateStore/State.ts` -> `Providers.ts` -> `Auth/AuthProvider.ts`).
 */
export const CREDENTIALS_FILE = "cloudflare-state-store";

/**
 * On-disk shape of the cached Cloudflare state-store credentials.
 *
 * Extends the generic `HttpStateStoreCredentials` (`{ url, authToken }`)
 * with the `accountId` the credentials were minted against. The `url` already
 * encodes the account (via the `*.workers.dev` subdomain), so a cache written
 * while logged into account A keeps pointing at account A's state store even
 * after the user re-authenticates against account B. Persisting `accountId`
 * lets `state()` detect that mismatch and re-derive.
 *
 * `accountId` is optional so legacy files written before this field existed
 * still parse — they are treated as stale (see
 * {@link isStateStoreCredentialsStale}) and re-derived on next use.
 */
export const StoredStateStoreCredentials = Schema.Struct({
  url: Schema.String,
  /** Bearer token used to authenticate every request. */
  authToken: Schema.String,
  /** Cloudflare account ID the `url`/`authToken` were minted against. */
  accountId: Schema.optional(Schema.String),
});
export type StoredStateStoreCredentials = typeof StoredStateStoreCredentials.Type;

/**
 * `true` when cached state-store credentials must not be trusted for the
 * current account:
 *
 * - the file predates the `accountId` field (legacy cache — exactly the
 *   artifact that caused deploys to silently target the wrong account), or
 * - it was minted against a different account than the one now in use.
 *
 * A stale cache is discarded and re-derived from the current account.
 */
export const isStateStoreCredentialsStale = (
  credentials: StoredStateStoreCredentials,
  currentAccountId: string,
): boolean => credentials.accountId == null || credentials.accountId !== currentAccountId;

/** The default state store's name; a legacy file holds its credentials alone. */
const DEFAULT_STORE = "alchemy-state-store";

/**
 * Every state store's cached credentials for a profile, by store name, in
 * the one {@link CREDENTIALS_FILE}: deleting the file (on `profile edit`,
 * logout, or an account change) clears them all. A legacy file holds the
 * default store's credentials alone.
 */
const StoredStateStores = Schema.Union([
  Schema.Struct({ stores: Schema.Record(Schema.String, StoredStateStoreCredentials) }),
  StoredStateStoreCredentials,
]);

const readStores = (store: CredentialsStoreService, profile: string) =>
  Effect.map(store.read(profile, CREDENTIALS_FILE, StoredStateStores), (file) =>
    file === undefined
      ? {}
      : "stores" in file
        ? file.stores
        : ({ [DEFAULT_STORE]: file } as Record<string, StoredStateStoreCredentials>),
  );

/** One state store's cached credentials, if any. */
export const readStoreCredentials = (
  store: CredentialsStoreService,
  profile: string,
  storeName: string,
) => Effect.map(readStores(store, profile), (stores) => stores[storeName]);

/** Cache one state store's credentials beside the profile's other stores. */
export const writeStoreCredentials = (
  store: CredentialsStoreService,
  profile: string,
  storeName: string,
  credentials: StoredStateStoreCredentials,
) =>
  Effect.flatMap(readStores(store, profile), (stores) =>
    store.write(profile, CREDENTIALS_FILE, StoredStateStores, {
      stores: { ...stores, [storeName]: credentials },
    }),
  );

/** Drop one state store's cached credentials; the file goes with the last. */
export const deleteStoreCredentials = (
  store: CredentialsStoreService,
  profile: string,
  storeName: string,
) =>
  Effect.flatMap(readStores(store, profile), ({ [storeName]: _, ...rest }) =>
    Object.keys(rest).length === 0
      ? store.delete(profile, CREDENTIALS_FILE)
      : store.write(profile, CREDENTIALS_FILE, StoredStateStores, { stores: rest }),
  );
