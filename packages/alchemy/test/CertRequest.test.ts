import * as NodeCrypto from "node:crypto";
import { CertRequest, CertRequestProvider } from "@/CertRequest";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  EC_P256_KEY,
  EC_P256_KEY_2,
  ED25519_KEY,
  RSA_2048_KEY,
  X25519_KEY,
} from "./fixtures/cert-request-keys.ts";

const { test, beforeAll } = Test.make({
  providers: CertRequestProvider(),
  state: inMemoryState(),
});

const runOpenssl = Effect.fn(function* (args: string[], input: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("openssl", args, {
      stdin: Stream.make(new TextEncoder().encode(input)),
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  return yield* Effect.all(
    {
      exitCode: child.exitCode,
      stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
    },
    { concurrency: "unbounded" },
  );
});

// The openssl tests are skipped at run time when the binary is absent.
const hasOpenssl = beforeAll(
  runOpenssl(["version"], "").pipe(
    Effect.map((result) => result.exitCode === 0),
    Effect.orElseSucceed(() => false),
  ),
);

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

const verifiesWithOpenssl = (csrPem: string) =>
  runOpenssl(["req", "-verify", "-noout"], csrPem).pipe(
    Effect.map((result) => result.exitCode === 0),
  );

const opensslText = (csrPem: string) =>
  runOpenssl(["req", "-noout", "-text"], csrPem).pipe(
    Effect.map((result) => result.stdout),
  );

const expectCertRequestError = (error: unknown, message: RegExp) => {
  expect(error).toMatchObject({ _tag: "CertRequestError" });
  expect((error as { message: string }).message).toMatch(message);
};

describe("Alchemy.CertRequest", () => {
  test.provider("generates a verifiable ec CSR with CN and SAN", (stack) =>
    Effect.gen(function* () {
      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CertRequest("ec-csr", {
            privateKey: Redacted.make(EC_P256_KEY),
            commonName: "origin.example.com",
            dnsNames: ["origin.example.com", "*.example.com"],
          });
        }),
      );
      expect(attrs.csr).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/);
      expect(verifiesWithNodeCrypto(attrs.csr, EC_P256_KEY, "ec")).toBe(true);
    }),
  );

  test.provider(
    "generates a verifiable rsa CSR with an empty subject",
    (stack) =>
      Effect.gen(function* () {
        const attrs = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* CertRequest("rsa-csr", { privateKey: RSA_2048_KEY });
          }),
        );
        expect(verifiesWithNodeCrypto(attrs.csr, RSA_2048_KEY, "rsa")).toBe(
          true,
        );
        expect(attrs.dnsNames).toEqual([]);
      }),
  );

  test.provider("generates a verifiable ed25519 CSR", (stack) =>
    Effect.gen(function* () {
      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CertRequest("ed-csr", {
            privateKey: ED25519_KEY,
            commonName: "example.com",
          });
        }),
      );
      expect(verifiesWithNodeCrypto(attrs.csr, ED25519_KEY, "ed25519")).toBe(
        true,
      );
    }),
  );

  test.provider("treats an empty commonName as omitted", (stack) =>
    Effect.gen(function* () {
      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CertRequest("empty-cn-csr", {
            privateKey: EC_P256_KEY,
            commonName: "",
          });
        }),
      );
      expect(attrs.commonName).toBeUndefined();
      expect(verifiesWithNodeCrypto(attrs.csr, EC_P256_KEY, "ec")).toBe(true);
    }),
  );

  test.provider(
    "openssl verifies the CSR and prints the requested subject and SANs",
    (stack) =>
      Effect.gen(function* () {
        if (!(yield* hasOpenssl)) return;
        const attrs = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* CertRequest("openssl-csr", {
              privateKey: EC_P256_KEY,
              commonName: "origin.example.com",
              dnsNames: ["origin.example.com", "*.example.com"],
            });
          }),
        );
        expect(yield* verifiesWithOpenssl(attrs.csr)).toBe(true);
        const text = yield* opensslText(attrs.csr);
        expect(text).toMatch(/Subject:.*CN\s*=\s*origin\.example\.com/);
        // The DNS: prefix proves the SAN entries carry the dNSName tag —
        // `openssl req -verify` alone would accept any GeneralName tag.
        expect(text).toContain("DNS:origin.example.com");
        expect(text).toContain("DNS:*.example.com");
      }),
  );

  test.provider("openssl verifies rsa and ed25519 CSRs", (stack) =>
    Effect.gen(function* () {
      if (!(yield* hasOpenssl)) return;
      const rsaRequest = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CertRequest("openssl-rsa", {
            privateKey: RSA_2048_KEY,
          });
        }),
      );
      expect(yield* verifiesWithOpenssl(rsaRequest.csr)).toBe(true);

      const ed25519Request = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CertRequest("openssl-ed", {
            privateKey: ED25519_KEY,
            commonName: "example.com",
          });
        }),
      );
      expect(yield* verifiesWithOpenssl(ed25519Request.csr)).toBe(true);
    }),
  );

  test.provider(
    "preserves the CSR across deploys for the same inputs",
    (stack) =>
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          return yield* CertRequest("stable-csr", {
            privateKey: EC_P256_KEY,
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

      const first = yield* stack.deploy(program(EC_P256_KEY));
      const second = yield* stack.deploy(program(EC_P256_KEY_2));

      expect(second.keyFingerprint).not.toBe(first.keyFingerprint);
      expect(second.csr).not.toBe(first.csr);
      expect(verifiesWithNodeCrypto(second.csr, EC_P256_KEY_2, "ec")).toBe(
        true,
      );
    }),
  );

  test.provider("regenerates when names change", (stack) =>
    Effect.gen(function* () {
      const program = (dnsNames: string[]) =>
        Effect.gen(function* () {
          return yield* CertRequest("names-csr", {
            privateKey: EC_P256_KEY,
            commonName: "example.com",
            dnsNames,
          });
        });

      const first = yield* stack.deploy(program(["example.com"]));
      const second = yield* stack.deploy(
        program(["example.com", "www.example.com"]),
      );

      expect(second.csr).not.toBe(first.csr);
      expect(second.dnsNames).toEqual(["example.com", "www.example.com"]);
      expect(verifiesWithNodeCrypto(second.csr, EC_P256_KEY, "ec")).toBe(true);
    }),
  );

  test.provider("reordering dnsNames does not regenerate", (stack) =>
    Effect.gen(function* () {
      const program = (dnsNames: string[]) =>
        Effect.gen(function* () {
          return yield* CertRequest("reordered-csr", {
            privateKey: EC_P256_KEY,
            dnsNames,
          });
        });

      const first = yield* stack.deploy(
        program(["example.com", "www.example.com"]),
      );
      const second = yield* stack.deploy(
        program(["www.example.com", "example.com"]),
      );

      expect(second.csr).toBe(first.csr);
    }),
  );

  test.provider("rejects invalid dnsNames with a typed error", (stack) =>
    Effect.gen(function* () {
      const deploy = (dnsNames: string[]) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* CertRequest("invalid-names-csr", {
              privateKey: EC_P256_KEY,
              dnsNames,
            });
          }),
        );

      expectCertRequestError(
        yield* Effect.flip(deploy(["bücher.example"])),
        /punycode.*"bücher\.example"/,
      );
      expectCertRequestError(
        yield* Effect.flip(deploy(["exa mple.com"])),
        /hostname.*"exa mple\.com"/,
      );
      expectCertRequestError(yield* Effect.flip(deploy([""])), /empty/);
      expectCertRequestError(
        yield* Effect.flip(deploy(["host-"])),
        /hostname.*"host-"/,
      );
    }),
  );

  test.provider("rejects an unparseable private key", (stack) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* CertRequest("bad-key-csr", {
              privateKey: "not a pem",
            });
          }),
        ),
      );
      expectCertRequestError(error, /Cannot parse privateKey/);
    }),
  );

  test.provider("rejects an unsupported key type", (stack) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* CertRequest("x25519-csr", {
              privateKey: X25519_KEY,
            });
          }),
        ),
      );
      expectCertRequestError(error, /supports ec, rsa, and ed25519/);
    }),
  );

  test.provider("list returns [] for the non-listable CSR", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CertRequest("list-csr", { privateKey: EC_P256_KEY });
        }),
      );

      const provider = yield* Provider.findProvider(CertRequest);
      expect(yield* provider.list()).toEqual([]);

      yield* stack.destroy();
    }),
  );
});
