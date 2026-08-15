import type { HttpStateStoreCredentials } from "../../State/HttpStateStore.ts";

/**
 * Filename (under `~/.alchemy/credentials/{profile}/`) used to cache the
 * Vercel-deployed HTTP state store's endpoint + bearer token.
 *
 * Kept in this leaf module (rather than `StateStore/State.ts`) so the
 * Vercel auth provider can invalidate the cache without importing the
 * heavy state-store module — mirrors
 * `Cloudflare/StateStore/CredentialsFile.ts`.
 */
export const CREDENTIALS_FILE = "vercel-state";

/**
 * On-disk shape of the cached Vercel state-store credentials.
 *
 * Extends the generic {@link HttpStateStoreCredentials} with the
 * `teamId` the credentials were minted against (`undefined` = personal
 * scope). The `url` encodes the team implicitly (the state project
 * lives in one team), so a cache written while configured for team A
 * keeps pointing at team A's store after re-authenticating against
 * team B — persisting `teamId` lets `state()` detect the mismatch and
 * re-derive.
 */
export interface StoredStateStoreCredentials extends HttpStateStoreCredentials {
  /** Vercel team the `url`/`authToken` were minted against. */
  teamId?: string;
}

/**
 * `true` when cached state-store credentials must not be trusted for
 * the current scope: minted against a different team (or personal
 * scope) than the one now in use.
 */
export const isStateStoreCredentialsStale = (
  credentials: StoredStateStoreCredentials,
  currentTeamId: string | undefined,
): boolean => (credentials.teamId ?? null) !== (currentTeamId ?? null);
