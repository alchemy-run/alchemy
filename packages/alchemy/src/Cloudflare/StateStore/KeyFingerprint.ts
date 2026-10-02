import * as Effect from "effect/Effect";

/**
 * Guard against an encryption-key rotation silently wiping a state store.
 *
 * Every stack Durable Object records a fingerprint of the key that encrypts
 * its entries the first time it decrypts or encrypts anything. Later boots
 * compare the key they were handed against that record. A mismatch means
 * the `AlchemyStateStoreEncryptionKey` secret changed underneath the data:
 * every entry would decode as garbage, read back as "absent", and the next
 * deploy would overwrite the ciphertext with entries under the new key —
 * the 2.0.0-beta.45 incident. The store refuses to serve data instead.
 *
 * The fingerprint is a SHA-256 of the raw key bytes: safe to persist next
 * to the data, and useless for recovering the key.
 */

/**
 * Storage key of the recorded fingerprint inside a stack Durable Object.
 * Deliberately outside the `r\0` (resource) and `o\0` (stack output)
 * prefixes so listings never surface it, and outside the root DO's `s:`
 * stack index.
 */
export const KEY_FINGERPRINT_KEY = "k:fingerprint";

/** SHA-256 hex digest of the hex-encoded key. */
export const keyFingerprint = async (keyHex: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Buffer.from(keyHex, "hex"),
  );
  return Buffer.from(digest).toString("hex");
};

export type KeyFingerprintCheck = "recorded" | "match" | "mismatch";

/** The subset of Durable Object storage the check needs. */
export interface FingerprintStorage<R = never> {
  readonly get: (key: string) => Effect.Effect<string | undefined, never, R>;
  readonly put: (key: string, value: string) => Effect.Effect<void, never, R>;
}

/**
 * Record `fingerprint` if this store has none yet, otherwise compare. The
 * first v8 boot of a pre-existing store records whatever key it has —
 * entries written under an older, rotated key (the beta.45 leftovers) stay
 * unreadable and keep degrading to "absent", exactly as before, but any
 * *future* rotation is caught.
 */
export const verifyKeyFingerprint = <R = never>(
  storage: FingerprintStorage<R>,
  fingerprint: string,
): Effect.Effect<KeyFingerprintCheck, never, R> =>
  Effect.gen(function* () {
    const recorded = yield* storage.get(KEY_FINGERPRINT_KEY);
    if (recorded === undefined) {
      yield* storage.put(KEY_FINGERPRINT_KEY, fingerprint);
      return "recorded";
    }
    return recorded === fingerprint ? "match" : "mismatch";
  });

/** Raised (as a defect) by every data method once a mismatch is detected. */
export class EncryptionKeyChangedError extends Error {
  override readonly name = "EncryptionKeyChangedError";
  constructor() {
    super(
      "Cloudflare State Store: the encryption key bound to this store " +
        "(Secrets Store secret 'AlchemyStateStoreEncryptionKey') is not the " +
        "key that encrypted its data. Refusing to read or write state — " +
        "serving it would report every resource as missing and the next " +
        "deploy would overwrite the still-recoverable ciphertext. Restore " +
        "the previous secret value to recover. If that key is truly lost, " +
        "delete the affected stack's state deliberately with " +
        "`alchemy state delete <stack> --backend cloudflare --recursive`.",
    );
  }
}
