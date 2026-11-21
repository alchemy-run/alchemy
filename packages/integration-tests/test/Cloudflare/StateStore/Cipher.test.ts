import { makeStateCipher } from "@alchemy.run/cloudflare/StateStore/Cipher";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const KEY = "3a".repeat(32);
const DIFFERENT_KEY = "4b".repeat(32);
const STORAGE_KEY = "r\0production\0Alchemy.Random";
const STORE_ID = "00112233445566778899aabbccddeeff";
const OTHER_STORE_ID = "ffeeddccbbaa99887766554433221100";
const SECRET = "HTTP_STATE_ENCRYPTION_SENTINEL_NOT_LOGGED";

// The legacy on-disk format is exactly counter[16] || AES-CTR ciphertext.
// This fixture uses native Web Crypto to verify that new readers can recover
// the bytes existing deployed workers wrote, with no key rotation.
const oldCtrRecord = async (value: unknown) => {
  const key = await crypto.subtle.importKey("raw", Buffer.from(KEY, "hex"), "AES-CTR", false, [
    "encrypt",
  ]);
  const counter = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter, length: 64 },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Buffer.concat([counter, new Uint8Array(ciphertext)]).toString("base64");
};

describe(
  "Cloudflare state cipher",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:statestore", "local"] },
  () => {
    it.effect(
      "encrypts all new writes with randomized, authenticated AES-GCM and preserves redaction",
      () =>
        Effect.gen(function* () {
          const cipher = yield* makeStateCipher(KEY, STORE_ID);
          const value = { attr: { text: Redacted.make(SECRET) } };
          const first = yield* cipher.encrypt(value, STORAGE_KEY);
          const second = yield* cipher.encrypt(value, STORAGE_KEY);
          expect(first.startsWith("gcm:v1:")).toBe(true);
          expect(first).not.toContain(SECRET);
          expect(second).not.toBe(first);
          const decoded = yield* cipher.decrypt(first, STORAGE_KEY);
          expect(decoded).toEqual({ attr: { text: { __redacted__: SECRET } } });
        }),
    );

    it.effect("rejects tampering, substitution and a wrong key without revealing the secret", () =>
      Effect.gen(function* () {
        const cipher = yield* makeStateCipher(KEY, STORE_ID);
        const wrong = yield* makeStateCipher(DIFFERENT_KEY, STORE_ID);
        const anotherStack = yield* makeStateCipher(KEY, OTHER_STORE_ID);
        const ciphertext = yield* cipher.encrypt(
          { attr: { text: Redacted.make(SECRET) } },
          STORAGE_KEY,
        );

        // Flip a ciphertext bit outside the GCM nonce. The authentication
        // tag must fail and the error must never be converted to undefined.
        const bytes = Buffer.from(ciphertext.slice("gcm:v1:".length), "base64");
        bytes[bytes.length - 18] ^= 0x01;
        const tampered = "gcm:v1:" + bytes.toString("base64");
        const invalid = [
          yield* Effect.result(cipher.decrypt(tampered, STORAGE_KEY)),
          yield* Effect.result(cipher.decrypt(ciphertext, "r\0production\0DifferentResource")),
          // Identical internal keys on separate named stack DOs cannot be substituted.
          yield* Effect.result(anotherStack.decrypt(ciphertext, STORAGE_KEY)),
          yield* Effect.result(wrong.decrypt(ciphertext, STORAGE_KEY)),
          yield* Effect.result(cipher.decrypt("gcm:v1:bad", STORAGE_KEY)),
        ];
        for (const result of invalid) {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("StateStoreError");
            expect(result.failure.message).not.toContain(SECRET);
          }
        }
      }),
    );

    it.effect(
      "reads an existing AES-CTR record with the original key and writes the new format",
      () =>
        Effect.gen(function* () {
          const legacy = yield* Effect.promise(() =>
            oldCtrRecord({ attr: { text: { __redacted__: SECRET } }, status: "created" }),
          );
          const cipher = yield* makeStateCipher(KEY, STORE_ID);
          expect(yield* cipher.decrypt(legacy, STORAGE_KEY)).toEqual({
            attr: { text: { __redacted__: SECRET } },
            status: "created",
          });
          const upgraded = yield* cipher.encrypt(
            yield* cipher.decrypt(legacy, STORAGE_KEY),
            STORAGE_KEY,
          );
          expect(upgraded.startsWith("gcm:v1:")).toBe(true);
          expect(yield* cipher.decrypt(upgraded, STORAGE_KEY)).toEqual({
            attr: { text: { __redacted__: SECRET } },
            status: "created",
          });
        }),
    );

    it.effect("refuses invalid key material instead of treating stored state as absent", () =>
      Effect.gen(function* () {
        for (const key of ["", "zero", "00".repeat(31), "zz".repeat(32)]) {
          const result = yield* Effect.result(makeStateCipher(key, STORE_ID));
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("StateStoreError");
            if (key !== "") expect(result.failure.message).not.toContain(key);
          }
        }
      }),
    );
  },
);
