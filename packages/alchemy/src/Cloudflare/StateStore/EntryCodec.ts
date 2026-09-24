import { encodeState } from "../../State/StateEncoding.ts";

/**
 * At-rest encryption of the Cloudflare State Store's Durable Object
 * entries: AES-CTR over the JSON-encoded state, framed as a single base64
 * string `nonce || ciphertext`.
 *
 * Kept as plain Web Crypto functions (no Effect, no DO bindings) so the
 * codec can be unit-tested outside a worker. `Store.ts` wraps them.
 */

/** AES-CTR counter block length. */
export const NONCE_BYTES = 16;

/** Import the hex-encoded 32-byte key held in the Secrets Store. */
export const importEntryKey = (keyHex: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    Buffer.from(keyHex, "hex"),
    { name: "AES-CTR" },
    false,
    ["encrypt", "decrypt"],
  );

/** Encode (`encodeState`) and encrypt a value under a fresh random nonce. */
export const encryptEntry = async (
  cryptoKey: CryptoKey,
  value: unknown,
): Promise<string> => {
  const plaintext = new TextEncoder().encode(
    JSON.stringify(encodeState(value)),
  );
  const counter = crypto.getRandomValues(allocBytes(NONCE_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CTR", counter, length: 64 },
      cryptoKey,
      plaintext,
    ),
  );
  // Frame as a single base64 string: nonce || ciphertext.
  return Buffer.concat([counter, ct]).toString("base64");
};

/**
 * Decrypt and decode an entry. Resolves `undefined` — never rejects — when
 * the entry cannot be read.
 *
 * In 2.0.0-beta.45 the state store bootstrap rotated encryption keys
 * unnecessarily, so entries written under the previous key exist in the
 * wild. AES-CTR is unauthenticated: decrypting with the wrong key does NOT
 * fail in Web Crypto, it yields random bytes, and the failure only surfaces
 * when those bytes are decoded as JSON. Both the decrypt step and the JSON
 * decode therefore live inside the same guard, so an unreadable entry
 * degrades to "absent" and the engine reconciles the resource (users may
 * lose some data) instead of the whole deploy dying on a `SyntaxError`.
 */
export const decryptEntry = async <T>(
  cryptoKey: CryptoKey,
  entry: string,
): Promise<T | undefined> => {
  try {
    const framed = Buffer.from(entry, "base64");
    const counter = framed.subarray(0, NONCE_BYTES);
    const ciphertext = framed.subarray(NONCE_BYTES);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-CTR", counter, length: 64 },
      cryptoKey,
      ciphertext,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (error) {
    console.error(
      "Error decrypting or decoding entry. Returning undefined instead.",
      error,
    );
    return undefined;
  }
};

/**
 * Allocate a `Uint8Array` over a fresh `ArrayBuffer` (not shared) so
 * the resulting buffer satisfies Web Crypto's `BufferSource` type
 * constraint under strict DOM typings.
 */
const allocBytes = (size: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new ArrayBuffer(size));
