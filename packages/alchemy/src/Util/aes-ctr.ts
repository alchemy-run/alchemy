import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Web Crypto AES-CTR helpers over a compact wire format: every payload is
 * framed as `base64(nonce || ciphertext)` with a random 16-byte counter
 * block per encryption, so a single string round-trips through JSON/KV
 * storage without extra bookkeeping.
 */

/** AES-CTR counter block length. */
const NONCE_BYTES = 16;

/**
 * Allocate a `Uint8Array` over a fresh `ArrayBuffer` (not shared) so the
 * buffer satisfies Web Crypto's `BufferSource` under strict DOM typings.
 */
const allocBytes = (size: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new ArrayBuffer(size));

/** Copy arbitrary bytes into a fresh non-shared buffer for Web Crypto. */
const toBufferSource = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = allocBytes(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

/** Decryption failed — wrong key, truncated frame, or corrupt ciphertext. */
export class AesCtrDecryptError extends Data.TaggedError("AesCtrDecryptError")<{
  message: string;
  cause?: unknown;
}> {}

/** Import a hex-encoded 256-bit key as an AES-CTR `CryptoKey`. */
export const importAesCtrKey = (keyHex: string): Effect.Effect<CryptoKey> =>
  Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      Buffer.from(keyHex, "hex"),
      { name: "AES-CTR" },
      false,
      ["encrypt", "decrypt"],
    ),
  );

/** Encrypt raw bytes; returns `base64(nonce || ciphertext)`. */
export const aesCtrEncrypt = (
  key: CryptoKey,
  plaintext: Uint8Array,
): Effect.Effect<string> =>
  Effect.promise(async () => {
    const counter = crypto.getRandomValues(allocBytes(NONCE_BYTES));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-CTR", counter, length: 64 },
        key,
        toBufferSource(plaintext),
      ),
    );
    return Buffer.concat([counter, ciphertext]).toString("base64");
  });

/** Decrypt a `base64(nonce || ciphertext)` frame back to raw bytes. */
export const aesCtrDecrypt = (
  key: CryptoKey,
  framedBase64: string,
): Effect.Effect<Uint8Array, AesCtrDecryptError> =>
  Effect.tryPromise({
    try: async () => {
      const framed = Buffer.from(framedBase64, "base64");
      const counter = toBufferSource(framed.subarray(0, NONCE_BYTES));
      const ciphertext = toBufferSource(framed.subarray(NONCE_BYTES));
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-CTR", counter, length: 64 },
        key,
        ciphertext,
      );
      return new Uint8Array(decrypted);
    },
    catch: (cause) =>
      new AesCtrDecryptError({
        message: `AES-CTR decryption failed: ${String(cause)}`,
        cause,
      }),
  });

/** Encrypt a JSON-serializable value; returns `base64(nonce || ciphertext)`. */
export const aesCtrEncryptJson = (
  key: CryptoKey,
  value: unknown,
): Effect.Effect<string> =>
  Effect.suspend(() =>
    aesCtrEncrypt(key, new TextEncoder().encode(JSON.stringify(value))),
  );

/**
 * Decrypt a `base64(nonce || ciphertext)` frame and parse the plaintext as
 * JSON. AES-CTR decryption with the wrong key "succeeds" with garbage
 * bytes, so an unparseable plaintext is reported as the same typed error.
 */
export const aesCtrDecryptJson = <T>(
  key: CryptoKey,
  framedBase64: string,
): Effect.Effect<T, AesCtrDecryptError> =>
  aesCtrDecrypt(key, framedBase64).pipe(
    Effect.flatMap((plaintext) =>
      Effect.try({
        try: () => JSON.parse(new TextDecoder().decode(plaintext)) as T,
        catch: (cause) =>
          new AesCtrDecryptError({
            message:
              "decrypted payload is not valid JSON (wrong key or corrupt data)",
            cause,
          }),
      }),
    ),
  );
