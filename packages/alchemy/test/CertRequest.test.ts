import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { CertRequest, CertRequestProvider } from "@/CertRequest";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({
  providers: CertRequestProvider(),
  state: inMemoryState(),
});

const makeKey = (algorithm: "ec" | "rsa" | "ed25519"): string => {
  if (algorithm === "rsa") {
    return NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
  }
  if (algorithm === "ec") {
    return NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
  }
  return NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
};

/** Split one DER TLV at `offset` into its tag, body, and total length. */
const readTlv = (
  der: Uint8Array,
  offset: number,
): { tag: number; body: Uint8Array; length: number } => {
  const tag = der[offset];
  let length = der[offset + 1];
  let headerLength = 2;
  if (length >= 0x80) {
    const lengthBytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < lengthBytes; i++) {
      length = length * 256 + der[offset + 2 + i];
    }
    headerLength = 2 + lengthBytes;
  }
  return {
    tag,
    body: der.slice(offset + headerLength, offset + headerLength + length),
    length: headerLength + length,
  };
};

/** The three elements of a CertificationRequest, plus the signed info DER. */
const parseCsr = (pem: string) => {
  const base64 = pem
    .replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, "")
    .replace(/\s/g, "");
  const der = new Uint8Array(Buffer.from(base64, "base64"));
  const outer = readTlv(der, 0);
  expect(outer.tag).toBe(0x30);
  expect(outer.length).toBe(der.length);
  const infoStart = der.length - outer.body.length;
  const info = readTlv(der, infoStart);
  const algorithm = readTlv(der, infoStart + info.length);
  const signature = readTlv(der, infoStart + info.length + algorithm.length);
  expect(signature.tag).toBe(0x03);
  return {
    // Signature input is the full info TLV (tag + length + body).
    signedInfo: der.slice(infoStart, infoStart + info.length),
    // BIT STRING body starts with the unused-bits count (always 0 here).
    signature: signature.body.slice(1),
  };
};

const verifiesWithNodeCrypto = (
  csrPem: string,
  privateKeyPem: string,
  algorithm: "ec" | "rsa" | "ed25519",
): boolean => {
  const { signedInfo, signature } = parseCsr(csrPem);
  return NodeCrypto.verify(
    algorithm === "ed25519" ? null : "sha256",
    signedInfo,
    NodeCrypto.createPublicKey(privateKeyPem),
    signature,
  );
};

const verifiesWithOpenssl = (csrPem: string): boolean => {
  const result = NodeChildProcess.spawnSync(
    "openssl",
    ["req", "-verify", "-noout"],
    { input: csrPem },
  );
  // No openssl on PATH — the node:crypto verification already ran.
  if (result.error !== undefined) return true;
  return result.status === 0;
};

const opensslSubjectAndSan = (csrPem: string): string => {
  const result = NodeChildProcess.spawnSync(
    "openssl",
    ["req", "-noout", "-text"],
    { input: csrPem },
  );
  if (result.error !== undefined) return "";
  return result.stdout.toString();
};

describe("Alchemy.CertRequest", () => {
  test.provider("generates a verifiable ec CSR with CN and SAN", (stack) =>
    Effect.gen(function* () {
      const privateKey = makeKey("ec");
      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CertRequest("ec-csr", {
            privateKey: Redacted.make(privateKey),
            commonName: "origin.example.com",
            dnsNames: ["origin.example.com", "*.example.com"],
          });
        }),
      );
      expect(attrs.csr).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/);
      expect(verifiesWithNodeCrypto(attrs.csr, privateKey, "ec")).toBe(true);
      expect(verifiesWithOpenssl(attrs.csr)).toBe(true);
      const text = opensslSubjectAndSan(attrs.csr);
      if (text !== "") {
        expect(text).toContain("origin.example.com");
        expect(text).toContain("*.example.com");
      }
    }),
  );

  test.provider(
    "generates a verifiable rsa CSR with an empty subject",
    (stack) =>
      Effect.gen(function* () {
        const privateKey = makeKey("rsa");
        const attrs = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* CertRequest("rsa-csr", { privateKey });
          }),
        );
        expect(verifiesWithNodeCrypto(attrs.csr, privateKey, "rsa")).toBe(true);
        expect(verifiesWithOpenssl(attrs.csr)).toBe(true);
        expect(attrs.dnsNames).toEqual([]);
      }),
  );

  test.provider("generates a verifiable ed25519 CSR", (stack) =>
    Effect.gen(function* () {
      const privateKey = makeKey("ed25519");
      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CertRequest("ed-csr", {
            privateKey,
            commonName: "example.com",
          });
        }),
      );
      expect(verifiesWithNodeCrypto(attrs.csr, privateKey, "ed25519")).toBe(
        true,
      );
      expect(verifiesWithOpenssl(attrs.csr)).toBe(true);
    }),
  );

  test.provider(
    "preserves the CSR across deploys for the same inputs",
    (stack) =>
      Effect.gen(function* () {
        const privateKey = makeKey("ec");
        const program = Effect.gen(function* () {
          return yield* CertRequest("stable-csr", {
            privateKey,
            commonName: "example.com",
          });
        });

        const first = yield* stack.deploy(program);
        const second = yield* stack.deploy(program);
        // ECDSA signatures are randomized: byte-equality proves the CSR was
        // persisted, not regenerated.
        expect(second.csr).toBe(first.csr);
      }),
  );

  test.provider("regenerates when the key changes", (stack) =>
    Effect.gen(function* () {
      const program = (privateKey: string) =>
        Effect.gen(function* () {
          return yield* CertRequest("rotating-csr", {
            privateKey,
            commonName: "example.com",
          });
        });

      const firstKey = makeKey("ec");
      const secondKey = makeKey("ec");
      const first = yield* stack.deploy(program(firstKey));
      const second = yield* stack.deploy(program(secondKey));

      expect(second.keyFingerprint).not.toBe(first.keyFingerprint);
      expect(second.csr).not.toBe(first.csr);
      expect(verifiesWithNodeCrypto(second.csr, secondKey, "ec")).toBe(true);
    }),
  );
});
