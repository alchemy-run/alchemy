import * as NodeCrypto from "node:crypto";
import { KeyPair, KeyPairProvider } from "@/KeyPair";
import { Provider } from "@/Provider";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const invokeReconcile = (
  news: KeyPair["Props"],
  output?: KeyPair["Attributes"],
) =>
  Effect.gen(function* () {
    const provider = yield* Provider<KeyPair>(KeyPair.Type);
    return yield* provider.reconcile({
      id: "test",
      instanceId: "test",
      news,
      olds: undefined,
      output,
      session: undefined as any,
      bindings: {} as any,
    });
  }).pipe(Effect.provide(KeyPairProvider()));

const assertPemKeyPair = (attrs: KeyPair["Attributes"]) => {
  const priv = Redacted.value(attrs.privateKey);
  expect(priv).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  expect(priv).toMatch(/-----END PRIVATE KEY-----/);
  expect(attrs.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  expect(attrs.publicKey).toMatch(/-----END PUBLIC KEY-----/);
  // Node will throw if the PEM is malformed.
  NodeCrypto.createPrivateKey(priv);
  NodeCrypto.createPublicKey(attrs.publicKey);
};

describe("Alchemy.KeyPair", () => {
  it.effect("mints an ed25519 keypair by default", () =>
    Effect.gen(function* () {
      const attrs = yield* invokeReconcile({});
      expect(attrs.algorithm).toBe("ed25519");
      assertPemKeyPair(attrs);
    }),
  );

  it.effect("mints an rsa keypair when requested", () =>
    Effect.gen(function* () {
      const attrs = yield* invokeReconcile({
        algorithm: "rsa",
        modulusLength: 2048,
      });
      expect(attrs.algorithm).toBe("rsa");
      assertPemKeyPair(attrs);
    }),
  );

  it.effect("mints an ec keypair when requested", () =>
    Effect.gen(function* () {
      const attrs = yield* invokeReconcile({
        algorithm: "ec",
        namedCurve: "P-256",
      });
      expect(attrs.algorithm).toBe("ec");
      assertPemKeyPair(attrs);
    }),
  );

  it.effect("preserves the keypair across reconciles", () =>
    Effect.gen(function* () {
      const first = yield* invokeReconcile({});
      const second = yield* invokeReconcile({}, first);
      expect(Redacted.value(second.privateKey)).toBe(
        Redacted.value(first.privateKey),
      );
      expect(second.publicKey).toBe(first.publicKey);
    }),
  );
});
