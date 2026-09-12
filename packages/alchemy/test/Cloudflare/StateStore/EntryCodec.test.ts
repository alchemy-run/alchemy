import {
  decryptEntry,
  encryptEntry,
  importEntryKey,
} from "@/Cloudflare/StateStore/EntryCodec.ts";
import { encodeState } from "@/State/StateEncoding.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { randomBytes } from "node:crypto";

/**
 * Hermetic tests for the Cloudflare State Store's entry codec — the same
 * Web Crypto code the Durable Object runs, exercised in-process.
 */

const keyHex = () => Buffer.from(randomBytes(32)).toString("hex");

const entry = {
  kind: "resource",
  resourceType: "Test.Resource",
  fqn: "worker",
  logicalId: "worker",
  instanceId: "i-1",
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: { apiKey: Redacted.make("sk-live-do-secret"), name: "wörker ✓" },
  attr: { url: "https://example.com" },
};

/**
 * Run `f` with `console.error` captured, returning its result and the
 * captured calls. The codec logs (rather than throws) on unreadable
 * entries, so the tests assert the log line exists instead of letting it
 * spray into the runner output.
 */
const capturingConsoleError = <T>(f: () => Promise<T>) =>
  Effect.promise(async () => {
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      return { result: await f(), calls };
    } finally {
      console.error = original;
    }
  });

describe("Cloudflare State Store entry codec", () => {
  it.effect(
    "round-trips an entry as the encoded (marker) form under a random nonce",
    () =>
      Effect.promise(async () => {
        const key = await importEntryKey(keyHex());
        const a = await encryptEntry(key, entry);
        const b = await encryptEntry(key, entry);

        // Base64 ciphertext, never the plaintext; a fresh nonce per write.
        expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
        expect(Buffer.from(a, "base64").toString("latin1")).not.toContain(
          "sk-live-do-secret",
        );
        expect(a).not.toBe(b);

        // The DO stores `encodeState`'s output and hands it back un-revived;
        // the HTTP client revives `__redacted__` markers on its side.
        expect(await decryptEntry(key, a)).toEqual(encodeState(entry));
        expect(await decryptEntry(key, b)).toEqual(encodeState(entry));
      }),
  );

  it.effect(
    "an entry written under a different key reads as absent (undefined), not as a thrown SyntaxError",
    () =>
      Effect.gen(function* () {
        // AES-CTR is unauthenticated: Web Crypto happily "decrypts" with
        // the wrong key and returns garbage, so the only failure signal is
        // the JSON decode. Before the fix that SyntaxError escaped the guard
        // and killed the whole deploy through `Effect.orDie`.
        const writer = yield* Effect.promise(() => importEntryKey(keyHex()));
        const reader = yield* Effect.promise(() => importEntryKey(keyHex()));
        const stored = yield* Effect.promise(() => encryptEntry(writer, entry));
        const { result, calls } = yield* capturingConsoleError(() =>
          decryptEntry(reader, stored),
        );
        expect(result).toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(String(calls[0]![0])).toContain("Returning undefined instead");
      }),
    { exclusive: true },
  );

  it.effect(
    "malformed or truncated entries read as absent, not as a rejection",
    () =>
      Effect.gen(function* () {
        const key = yield* Effect.promise(() => importEntryKey(keyHex()));
        const { result, calls } = yield* capturingConsoleError(async () => [
          await decryptEntry(key, ""),
          await decryptEntry(key, "not base64!!"),
          await decryptEntry(key, Buffer.from("short").toString("base64")),
        ]);
        expect(result).toEqual([undefined, undefined, undefined]);
        expect(calls.length).toBeGreaterThanOrEqual(1);
      }),
    { exclusive: true },
  );
});
