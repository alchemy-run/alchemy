import * as NodeCrypto from "node:crypto";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { CertRequest, CertRequestProvider, type CertRequestProps } from "@/CertRequest";
import { inMemoryState } from "@/State";
import {
  EC_P256_KEY,
  EC_P256_KEY_2,
  ED25519_KEY,
  RSA_2048_KEY,
  X25519_KEY,
} from "./fixtures/cert-request-keys.ts";

const { test } = Test.make({
  providers: CertRequestProvider(),
  state: inMemoryState(),
});

/** `openssl req -text -verify` over a PEM request. */
const inspectCsr = (pem: string) =>
  Effect.gen(function* () {
    const process = yield* ChildProcess.make("openssl", ["req", "-noout", "-text", "-verify"], {
      stdin: Stream.make(new TextEncoder().encode(pem)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = yield* Effect.all(
      [
        process.stdout.pipe(Stream.decodeText(), Stream.runCollect),
        process.stderr.pipe(Stream.decodeText(), Stream.runCollect),
        process.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    expect(code).toBe(0);
    return [...stdout, ...stderr].join("");
  });

const publicKeyFingerprint = (privateKeyPem: string) =>
  Effect.sync(() =>
    NodeCrypto.createHash("sha256")
      .update(NodeCrypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "der" }))
      .digest("hex"),
  );

const signers = [
  { type: "ec", privateKey: EC_P256_KEY, signatureAlgorithm: "ecdsa-with-SHA256" },
  { type: "rsa", privateKey: RSA_2048_KEY, signatureAlgorithm: "sha256WithRSAEncryption" },
  { type: "ed25519", privateKey: ED25519_KEY, signatureAlgorithm: "ED25519" },
] as const;

const rejections: Array<[description: string, props: CertRequestProps, message: RegExp]> = [
  [
    "a non-ASCII DNS name",
    { privateKey: EC_P256_KEY, dnsNames: ["bücher.example"] },
    /punycode.*"bücher\.example"/,
  ],
  [
    "a DNS name with a space",
    { privateKey: EC_P256_KEY, dnsNames: ["exa mple.com"] },
    /hostname.*"exa mple\.com"/,
  ],
  ["an empty DNS name", { privateKey: EC_P256_KEY, dnsNames: [""] }, /empty/],
  [
    "a label ending in a hyphen",
    { privateKey: EC_P256_KEY, dnsNames: ["host-"] },
    /hostname.*"host-"/,
  ],
  ["an unparseable private key", { privateKey: "not a pem" }, /Cannot parse privateKey/],
  ["an x25519 key", { privateKey: X25519_KEY }, /supports ec, rsa and ed25519/],
];

describe("Alchemy.CertRequest", { tags: ["unit", "local"] }, () => {
  for (const { type, privateKey, signatureAlgorithm } of signers) {
    test.provider(`signs a verifiable ${type} CSR with the common name and DNS names`, (stack) =>
      Effect.gen(function* () {
        const request = yield* stack.deploy(
          CertRequest(`${type}-csr`, {
            privateKey: Redacted.make(privateKey),
            commonName: "origin.example.com",
            dnsNames: ["origin.example.com", "*.example.com"],
          }),
        );

        const text = yield* inspectCsr(request.csr);
        expect(text).toMatch(/verify OK/i);
        expect(text).toContain(signatureAlgorithm);
        expect(text).toMatch(/Subject:.*CN\s*=\s*origin\.example\.com/);
        expect(text).toContain("DNS:origin.example.com");
        expect(text).toContain("DNS:*.example.com");
        expect(request.keyFingerprint).toBe(yield* publicKeyFingerprint(privateKey));
      }),
    );
  }

  test.provider("an empty commonName signs a CSR with an empty subject", (stack) =>
    Effect.gen(function* () {
      const request = yield* stack.deploy(
        CertRequest("empty-subject-csr", { privateKey: RSA_2048_KEY, commonName: "" }),
      );

      const text = yield* inspectCsr(request.csr);
      expect(text).toMatch(/verify OK/i);
      expect(text).not.toMatch(/CN\s*=/);
      expect(request.commonName).toBeUndefined();
      expect(request.dnsNames).toEqual([]);
    }),
  );

  test.provider("keeps the CSR while the key and names are unchanged", (stack) =>
    Effect.gen(function* () {
      const deploy = (dnsNames: string[]) =>
        stack.deploy(CertRequest("stable-csr", { privateKey: EC_P256_KEY, dnsNames }));

      const first = yield* deploy(["example.com", "www.example.com"]);
      const redeployed = yield* deploy(["example.com", "www.example.com"]);
      const reordered = yield* deploy(["www.example.com", "example.com"]);

      // ECDSA signatures are randomized, so equal bytes prove the CSR was kept.
      expect(redeployed.csr).toBe(first.csr);
      expect(reordered.csr).toBe(first.csr);
    }),
  );

  test.provider("signs a new CSR when the key changes", (stack) =>
    Effect.gen(function* () {
      const deploy = (privateKey: string) =>
        stack.deploy(CertRequest("rotating-csr", { privateKey, commonName: "example.com" }));

      const first = yield* deploy(EC_P256_KEY);
      const rotated = yield* deploy(EC_P256_KEY_2);

      expect(rotated.keyFingerprint).not.toBe(first.keyFingerprint);
      expect(rotated.keyFingerprint).toBe(yield* publicKeyFingerprint(EC_P256_KEY_2));
      expect(yield* inspectCsr(rotated.csr)).toMatch(/verify OK/i);
    }),
  );

  test.provider("signs a new CSR when the DNS names change", (stack) =>
    Effect.gen(function* () {
      const deploy = (dnsNames: string[]) =>
        stack.deploy(CertRequest("renamed-csr", { privateKey: EC_P256_KEY, dnsNames }));

      const first = yield* deploy(["example.com"]);
      const renamed = yield* deploy(["example.com", "www.example.com"]);

      expect(renamed.csr).not.toBe(first.csr);
      expect(renamed.dnsNames).toEqual(["example.com", "www.example.com"]);
      expect(yield* inspectCsr(renamed.csr)).toContain("DNS:www.example.com");
    }),
  );

  for (const [description, props, message] of rejections) {
    test.provider(`rejects ${description} with CertRequestError`, (stack) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(stack.deploy(CertRequest("rejected-csr", props)));

        expect(error).toMatchObject({
          _tag: "CertRequestError",
          message: expect.stringMatching(message),
        });
      }),
    );
  }
});
