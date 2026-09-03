import * as ACME from "@/ACME";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { spawnSync } from "node:child_process";
import { PEBBLE_ROOT } from "./Pebble.ts";

const opensslAvailable = (() => {
  try {
    return spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

/** `openssl req -text -verify` over a DER request. */
const inspectCsr = (der: Uint8Array) =>
  Effect.sync(() => {
    const result = spawnSync(
      "openssl",
      ["req", "-inform", "DER", "-noout", "-text", "-verify"],
      { input: Buffer.from(der), encoding: "utf8" },
    );
    return `${result.stdout}\n${result.stderr}`;
  });

describe("ACME PKI", () => {
  for (const algorithm of ["ES256", "RS256"] as const) {
    it.effect.skipIf(!opensslAvailable)(
      `${algorithm} CSR verifies and carries every identifier as a SAN`,
      () =>
        Effect.gen(function* () {
          const key = yield* ACME.generateKey(algorithm);
          expect(Redacted.value(key.privateKeyPem)).toContain(
            "BEGIN PRIVATE KEY",
          );
          const csr = yield* ACME.createCsr({
            key,
            identifiers: ["*.example.test", "example.test"],
          });
          const text = yield* inspectCsr(csr);
          expect(text).toMatch(/verify OK/i);
          expect(text).toContain("CN=*.example.test");
          expect(text).toContain("DNS:*.example.test");
          expect(text).toContain("DNS:example.test");
          expect(text).toContain(
            algorithm === "ES256"
              ? "ecdsa-with-SHA256"
              : "sha256WithRSAEncryption",
          );
        }),
    );
  }

  it.effect("parses a certificate's serial, validity, issuer and SANs", () =>
    Effect.gen(function* () {
      const parsed = yield* ACME.parseCertificate(PEBBLE_ROOT);
      expect(parsed.issuer).toContain("CN=minica root ca");
      expect(parsed.subject).toBe(parsed.issuer);
      expect(parsed.serial).toMatch(/^[0-9a-f]+$/);
      expect(parsed.notBefore.getUTCFullYear()).toBe(2025);
      expect(parsed.notAfter.getUTCFullYear()).toBe(2125);
      expect(parsed.dnsNames).toEqual([]);
    }),
  );

  it.effect("round-trips a PKCS#8 key through import and JWK export", () =>
    Effect.gen(function* () {
      const key = yield* ACME.generateKey("ES256");
      const imported = yield* ACME.importPrivateKey(key.privateKeyPem);
      expect(imported.algorithm).toBe("ES256");
      const jwk = JSON.parse(
        Redacted.value(yield* ACME.privateKeyToJwk(key.privateKeyPem)),
      ) as { kty: string; crv: string; d?: string };
      expect(jwk.kty).toBe("EC");
      expect(jwk.crv).toBe("P-256");
      expect(jwk.d).toBeDefined();
    }),
  );
});
