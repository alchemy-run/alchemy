import * as Effect from "effect/Effect";

/**
 * AES-CTR row codec for the Vercel state store.
 *
 * Mirrors the Cloudflare state store's at-rest framing exactly (see
 * `Cloudflare/StateStore/Store.ts`): each row is
 * `base64(nonce || ciphertext)` where the nonce is a random 16-byte
 * AES-CTR counter block. The key is 32 random bytes, hex-encoded,
 * minted once at bootstrap (`Alchemy.Random`) and delivered to the
 * deployed Function as a project env var.
 *
 * Kept as a leaf module (Web Crypto only — runs identically on the
 * Vercel Node runtime and under bun in tests) so the codec is
 * unit-testable without credentials.
 */

/** AES-CTR counter block length. */
export const NONCE_BYTES = 16;

/**
 * Allocate a `Uint8Array` over a fresh `ArrayBuffer` (not shared) so the
 * buffer satisfies Web Crypto's `BufferSource` constraint under strict
 * DOM typings.
 */
const allocBytes = (size: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new ArrayBuffer(size));

/** Decode a hex string into bytes (2 hex chars per byte). */
const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const bytes = allocBytes(hex.length >>> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const base64ToBytes = (base64: string): Uint8Array<ArrayBuffer> => {
  const buf = Buffer.from(base64, "base64");
  const bytes = allocBytes(buf.byteLength);
  bytes.set(buf);
  return bytes;
};

/** Import the hex-encoded 256-bit key as an AES-CTR `CryptoKey`. */
export const importStateKey = (hexKey: string): Effect.Effect<CryptoKey> =>
  Effect.tryPromise(() =>
    crypto.subtle.importKey(
      "raw",
      hexToBytes(hexKey),
      { name: "AES-CTR" },
      false,
      ["encrypt", "decrypt"],
    ),
  ).pipe(Effect.orDie);

/** Encrypt a JSON-serializable row value into `base64(nonce || ct)`. */
export const encryptRow = (
  key: CryptoKey,
  value: unknown,
): Effect.Effect<string> =>
  Effect.tryPromise(async () => {
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const counter = crypto.getRandomValues(allocBytes(NONCE_BYTES));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-CTR", counter, length: 64 },
        key,
        plaintext,
      ),
    );
    const framed = allocBytes(NONCE_BYTES + ciphertext.byteLength);
    framed.set(counter, 0);
    framed.set(ciphertext, NONCE_BYTES);
    return bytesToBase64(framed);
  }).pipe(Effect.orDie);

/**
 * Decrypt a framed row back into its JSON value. A row that fails to
 * decrypt (e.g. after an out-of-band key rotation) resolves to
 * `undefined` instead of failing, so the engine reconciles from scratch
 * rather than dying — mirrors the Cloudflare store's recovery behavior.
 */
export const decryptRow = <T = unknown>(
  key: CryptoKey,
  framed: string,
): Effect.Effect<T | undefined> =>
  Effect.tryPromise(async () => {
    const bytes = base64ToBytes(framed);
    const counter = bytes.subarray(0, NONCE_BYTES);
    const ciphertext = bytes.subarray(NONCE_BYTES);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: "AES-CTR", counter, length: 64 },
        key,
        ciphertext,
      );
    } catch (error) {
      console.error(
        "Vercel state store: failed to decrypt row; returning undefined.",
        error,
      );
      return undefined;
    }
    try {
      return JSON.parse(new TextDecoder().decode(plaintext)) as T;
    } catch (error) {
      console.error(
        "Vercel state store: decrypted row is not valid JSON; returning undefined.",
        error,
      );
      return undefined;
    }
  }).pipe(Effect.orDie);
