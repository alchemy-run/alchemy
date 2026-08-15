import { Random } from "../../Random.ts";

/**
 * Secrets of the Vercel state store, minted once at bootstrap and kept
 * stable across redeploys (`Alchemy.Random` persists its value in state).
 *
 * Both are delivered to the deployed state Function as `encrypted`
 * project env vars (bound from the bootstrap stack's composition, NOT
 * `sensitive`): Vercel's single-env GET (`getProjectEnv`) returns the
 * plaintext of `encrypted` rows to management-API credentials, which is
 * the out-of-band recovery path `loginWithVercel` uses when the local
 * credentials cache is lost — the Vercel-native equivalent of the
 * Cloudflare state store's Secrets-Store edge probe. The trust boundary
 * is identical: anyone with management access to the team can already
 * read/replace the store's data plane.
 */

/**
 * The bearer token every state API request must present. 32 random
 * bytes, hex-encoded.
 */
export const TokenValue = Random("VercelStateAuthToken");

/**
 * The 256-bit AES-CTR key (hex-encoded) that encrypts state rows at
 * rest in the Blob store.
 */
export const EncryptionKeyValue = Random("VercelStateEncryptionKey", {
  bytes: 32,
});

/** Project env var carrying the bearer token. */
export const STATE_TOKEN_ENV = "ALCHEMY_STATE_TOKEN" as const;

/** Project env var carrying the hex-encoded AES-CTR encryption key. */
export const STATE_ENCRYPTION_KEY_ENV = "ALCHEMY_STATE_ENCRYPTION_KEY" as const;
