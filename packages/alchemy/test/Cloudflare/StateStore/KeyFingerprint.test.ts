import {
  KEY_FINGERPRINT_KEY,
  keyFingerprint,
  verifyKeyFingerprint,
  type FingerprintStorage,
} from "@/Cloudflare/StateStore/KeyFingerprint.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { randomBytes } from "node:crypto";

/** In-memory stand-in for a stack Durable Object's storage. */
const fakeStorage = (): FingerprintStorage & { rows: Map<string, string> } => {
  const rows = new Map<string, string>();
  return {
    rows,
    get: (key) => Effect.sync(() => rows.get(key)),
    put: (key, value) =>
      Effect.sync(() => {
        rows.set(key, value);
      }),
  };
};

const keyHex = () => Buffer.from(randomBytes(32)).toString("hex");

describe("Cloudflare State Store encryption-key fingerprint", () => {
  it.effect(
    "is a stable SHA-256 of the key that reveals nothing about it",
    () =>
      Effect.promise(async () => {
        const key = keyHex();
        const a = await keyFingerprint(key);
        const b = await keyFingerprint(key);
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(a).not.toBe(key);
        expect(a).not.toContain(key.slice(0, 16));
        expect(await keyFingerprint(keyHex())).not.toBe(a);
      }),
  );

  it.effect("records the key on a store that has none, then matches it", () =>
    Effect.gen(function* () {
      const storage = fakeStorage();
      const fp = yield* Effect.promise(() => keyFingerprint(keyHex()));

      // First v8 boot of any store (fresh or pre-existing): record.
      expect(yield* verifyKeyFingerprint(storage, fp)).toBe("recorded");
      expect(storage.rows.get(KEY_FINGERPRINT_KEY)).toBe(fp);

      // Every later boot with the same key: match, nothing rewritten.
      expect(yield* verifyKeyFingerprint(storage, fp)).toBe("match");
      expect(storage.rows.size).toBe(1);
    }),
  );

  it.effect(
    "reports a rotated key as a mismatch and never overwrites the record",
    () =>
      Effect.gen(function* () {
        const storage = fakeStorage();
        const original = yield* Effect.promise(() => keyFingerprint(keyHex()));
        const rotated = yield* Effect.promise(() => keyFingerprint(keyHex()));
        yield* verifyKeyFingerprint(storage, original);

        expect(yield* verifyKeyFingerprint(storage, rotated)).toBe("mismatch");
        // The record still names the key that encrypted the data, so
        // restoring that key restores the store.
        expect(storage.rows.get(KEY_FINGERPRINT_KEY)).toBe(original);
        expect(yield* verifyKeyFingerprint(storage, original)).toBe("match");
      }),
  );

  it("keeps the record outside every listed key space", () => {
    // Stack DOs list `r\0…` (resources) and `o\0…` (outputs); the root DO
    // lists `s:…`. The record must never surface in any of them.
    expect(KEY_FINGERPRINT_KEY.startsWith("r\x00")).toBe(false);
    expect(KEY_FINGERPRINT_KEY.startsWith("o\x00")).toBe(false);
    expect(KEY_FINGERPRINT_KEY.startsWith("s:")).toBe(false);
  });
});
