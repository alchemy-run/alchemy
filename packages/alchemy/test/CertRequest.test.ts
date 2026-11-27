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

const inspectCsr = (pem: string) =>
  Effect.gen(function* () {
    const child = yield* ChildProcess.make("openssl", ["req", "-noout", "-text", "-verify"], {
      stdin: Stream.make(new TextEncoder().encode(pem)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.runCollect),
        child.stderr.pipe(Stream.decodeText(), Stream.runCollect),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    const output = [...stdout, ...stderr].join("");
    expect({ code, output }).toMatchObject({ code: 0 });
    return output;
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

const changes = [
  {
    change: "key changes",
    before: { privateKey: EC_P256_KEY },
    after: { privateKey: EC_P256_KEY_2 },
    shows: /verify OK/i,
  },
  {
    change: "common name changes",
    before: { privateKey: EC_P256_KEY, commonName: "a.example.com" },
    after: { privateKey: EC_P256_KEY, commonName: "b.example.com" },
    shows: /Subject:.*CN\s*=\s*b\.example\.com/,
  },
  {
    change: "DNS names change",
    before: { privateKey: EC_P256_KEY, dnsNames: ["example.com"] },
    after: { privateKey: EC_P256_KEY, dnsNames: ["example.com", "www.example.com"] },
    shows: /DNS:www\.example\.com/,
  },
] satisfies ReadonlyArray<{
  change: string;
  before: CertRequestProps;
  after: CertRequestProps;
  shows: RegExp;
}>;

const rejections = [
  {
    input: "a non-ASCII DNS name",
    props: { privateKey: EC_P256_KEY, dnsNames: ["bücher.example"] },
    message: /punycode.*"bücher\.example"/,
  },
  {
    input: "a DNS name with a space",
    props: { privateKey: EC_P256_KEY, dnsNames: ["exa mple.com"] },
    message: /hostname.*"exa mple\.com"/,
  },
  {
    input: "an empty DNS name",
    props: { privateKey: EC_P256_KEY, dnsNames: [""] },
    message: /empty/,
  },
  {
    input: "a label ending in a hyphen",
    props: { privateKey: EC_P256_KEY, dnsNames: ["host-"] },
    message: /hostname.*"host-"/,
  },
  {
    input: "an unparseable private key",
    props: { privateKey: "not a pem" },
    message: /Cannot parse privateKey/,
  },
  {
    input: "an x25519 key",
    props: { privateKey: X25519_KEY },
    message: /supports ec, rsa, ed25519/,
  },
] satisfies ReadonlyArray<{ input: string; props: CertRequestProps; message: RegExp }>;

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

  for (const { change, before, after, shows } of changes) {
    test.provider(`signs a new CSR when the ${change}`, (stack) =>
      Effect.gen(function* () {
        const first = yield* stack.deploy(CertRequest("changed-csr", before));
        const changed = yield* stack.deploy(CertRequest("changed-csr", after));

        expect(changed.csr).not.toBe(first.csr);
        expect(yield* inspectCsr(changed.csr)).toMatch(shows);
      }),
    );
  }

  for (const { input, props, message } of rejections) {
    test.provider(`rejects ${input} with CertRequestError`, (stack) =>
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
