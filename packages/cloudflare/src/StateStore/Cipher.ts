import { StateStoreError } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import * as Effect from "effect/Effect";

/**
 * State store encryption format.
 *
 * A prefixed, authenticated AES-256-GCM envelope is used for every new write.
 * The historical nonce+ciphertext AES-CTR format remains readable so a
 * worker upgrade never forces a key rotation or loses existing state.
 */
const GCM_PREFIX = "gcm:v1:";
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const LEGACY_CTR_NONCE_BYTES = 16;
const AAD_PREFIX = "alchemy/cloudflare/state/gcm:v1\0";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const cipherError = (operation: string) =>
  new StateStoreError({
    message: `Could not ${operation} encrypted state. Refusing to treat the record as absent; restore the state encryption key or an unmodified state backup.`,
  });

export interface StateCipher {
  /** Encrypt a resource or stack output, binding its storage identity. */
  encrypt: (value: unknown, storageKey: string) => Effect.Effect<string, StateStoreError>;
  /** Decrypt a current or legacy record; never downgrade errors to absence. */
  decrypt: (entry: string, storageKey: string) => Effect.Effect<unknown, StateStoreError>;
}

/**
 * Import the existing 256-bit secret without changing its raw bytes.
 *
 * Authenticate each record against its owning Durable Object ID and its
 * internal storage key. All named stack objects share one encryption key:
 * a resource key alone cannot prevent substitution across different stacks.
 */
export const makeStateCipher = (
  keyHex: string,
  durableObjectId: string,
): Effect.Effect<StateCipher, StateStoreError> =>
  Effect.tryPromise({
    try: async () => {
      if (!/^[a-f\d]{64}$/i.test(keyHex)) throw new Error("Invalid key length or encoding");
      const key = Buffer.from(keyHex, "hex");
      const [gcmKey, legacyCtrKey] = await Promise.all([
        crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]),
        crypto.subtle.importKey("raw", key, "AES-CTR", false, ["decrypt"]),
      ]);
      return {
        encrypt: (value, storageKey) =>
          Effect.tryPromise({
            try: async () => {
              const plaintext = encoder.encode(JSON.stringify(encodeState(value)));
              const iv = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
              const ciphertext = new Uint8Array(
                await crypto.subtle.encrypt(
                  {
                    name: "AES-GCM",
                    iv,
                    additionalData: encoder.encode(
                      AAD_PREFIX + durableObjectId + "\0" + storageKey,
                    ),
                    tagLength: 128,
                  },
                  gcmKey,
                  plaintext,
                ),
              );
              return GCM_PREFIX + Buffer.concat([iv, ciphertext]).toString("base64");
            },
            catch: () => cipherError("encrypt"),
          }),
        decrypt: (entry, storageKey) =>
          Effect.tryPromise({
            try: async () => {
              if (entry.startsWith(GCM_PREFIX)) {
                const framed = Buffer.from(entry.slice(GCM_PREFIX.length), "base64");
                if (framed.length < GCM_NONCE_BYTES + GCM_TAG_BYTES)
                  throw new Error("Truncated authenticated state");
                const plaintext = await crypto.subtle.decrypt(
                  {
                    name: "AES-GCM",
                    iv: framed.subarray(0, GCM_NONCE_BYTES),
                    additionalData: encoder.encode(
                      AAD_PREFIX + durableObjectId + "\0" + storageKey,
                    ),
                    tagLength: 128,
                  },
                  gcmKey,
                  framed.subarray(GCM_NONCE_BYTES),
                );
                return JSON.parse(decoder.decode(plaintext)) as unknown;
              }
              // Older deployments wrote base64(counter[16] || AES-CTR ciphertext)
              // with the same key. Read only: no new writes use unauthenticated CTR.
              // Legacy records have no integrity protection; on any failure,
              // never return undefined (which would silently rotate a secret).
              const framed = Buffer.from(entry, "base64");
              if (framed.length <= LEGACY_CTR_NONCE_BYTES)
                throw new Error("Truncated legacy state");
              const plaintext = await crypto.subtle.decrypt(
                {
                  name: "AES-CTR",
                  counter: framed.subarray(0, LEGACY_CTR_NONCE_BYTES),
                  length: 64,
                },
                legacyCtrKey,
                framed.subarray(LEGACY_CTR_NONCE_BYTES),
              );
              return JSON.parse(decoder.decode(plaintext)) as unknown;
            },
            catch: () => cipherError("decrypt"),
          }),
      } satisfies StateCipher;
    },
    catch: () => cipherError("initialize"),
  });
