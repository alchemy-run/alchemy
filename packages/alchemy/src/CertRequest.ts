import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "./Provider.ts";
import { Resource } from "./Resource.ts";

export interface CertRequestProps {
  /**
   * PEM-encoded private key the request is generated for (any format
   * `node:crypto` can parse — `pkcs8`, `sec1`, `pkcs1`). Supported key
   * types: `ec`, `rsa`, and `ed25519` — pair naturally with
   * {@link KeyPair}. The key itself never appears in the CSR or in this
   * resource's attributes.
   */
  privateKey: Redacted.Redacted<string> | string;
  /**
   * Subject common name (`CN=`). Omitted, the CSR carries an empty
   * subject — fine for CAs that take identities out-of-band (e.g.
   * Cloudflare Origin CA reads hostnames from the API request, not the
   * CSR).
   */
  commonName?: string;
  /**
   * DNS names for a `subjectAltName` extension request. Standard CAs
   * issue for these names; omit for CAs that ignore CSR names.
   */
  dnsNames?: string[];
}

export type CertRequest = Resource<
  "Alchemy.CertRequest",
  CertRequestProps,
  {
    /** The PKCS#10 certificate signing request, PEM-encoded. */
    csr: string;
    /**
     * SHA-256 hex digest of the key's SPKI (public half). Identifies
     * which key the persisted CSR belongs to without storing the key.
     */
    keyFingerprint: string;
    /** Subject common name the CSR was generated with. */
    commonName: string | undefined;
    /** subjectAltName DNS names the CSR was generated with. */
    dnsNames: string[];
  }
>;

/**
 * A PKCS#10 certificate signing request generated locally from a private
 * key — the bridge between {@link KeyPair} and any CA resource that signs
 * CSRs (e.g. `Cloudflare.OriginCaCertificate`). The private key never
 * leaves the machine; only the CSR (public) is stored.
 *
 * ECDSA and RSA signatures are randomized, so a regenerated CSR is
 * byte-different even for identical inputs. To keep downstream
 * certificate resources stable, the CSR is generated once and persisted
 * in state; it only regenerates when the key or the requested names
 * change.
 *
 * @resource
 *
 * @section Generating a CSR
 * @example CSR for a Cloudflare Origin CA certificate
 * ```typescript
 * const key = yield* KeyPair("origin-key", { algorithm: "ec" });
 * const csr = yield* CertRequest("origin-csr", {
 *   privateKey: key.privateKey,
 *   commonName: "example.com",
 *   dnsNames: ["example.com"],
 * });
 * const cert = yield* Cloudflare.OriginCaCertificate.OriginCaCertificate(
 *   "origin-cert",
 *   { csr: csr.csr, hostnames: ["example.com"], requestType: "origin-ecc" },
 * );
 * ```
 */
export const CertRequest = Resource<CertRequest>("Alchemy.CertRequest");

// ── PKCS#10 construction (DER, node:crypto only) ───────────────────────────

const concatBytes = (...parts: Array<Uint8Array | number[]>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part instanceof Uint8Array ? part : Uint8Array.from(part), offset);
    offset += part.length;
  }
  return out;
};

const derLength = (n: number): number[] => {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return [0x80 | bytes.length, ...bytes];
};

const tlv = (tag: number, body: Uint8Array | number[]): Uint8Array =>
  concatBytes([tag], derLength(body.length), body);

const sequence = (...parts: Array<Uint8Array | number[]>): Uint8Array =>
  tlv(0x30, concatBytes(...parts));

const oid = (dotted: string): Uint8Array => {
  const arcs = dotted.split(".").map(Number);
  const body: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const bytes: number[] = [];
    for (let v = arc; ; v = Math.floor(v / 128)) {
      bytes.unshift(v % 128);
      if (v < 128) break;
    }
    for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
    body.push(...bytes);
  }
  return tlv(0x06, body);
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Subject: `CN=<commonName>`, or the empty DN when no name is given. */
const subjectName = (commonName: string | undefined): Uint8Array =>
  commonName === undefined
    ? sequence()
    : sequence(
        tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, utf8(commonName)))),
      );

/**
 * `[0] IMPLICIT` CSR attributes: a PKCS#9 `extensionRequest` carrying a
 * `subjectAltName` of dNSNames, or empty when no names are requested.
 */
const attributes = (dnsNames: string[]): Uint8Array => {
  if (dnsNames.length === 0) return tlv(0xa0, []);
  const generalNames = sequence(
    ...dnsNames.map((name) => tlv(0x82, utf8(name))),
  );
  const extension = sequence(oid("2.5.29.17"), tlv(0x04, generalNames));
  return tlv(
    0xa0,
    sequence(oid("1.2.840.113549.1.9.14"), tlv(0x31, sequence(extension))),
  );
};

const signatureAlgorithm = (keyType: string): Uint8Array => {
  // ecdsa-with-SHA256 and Ed25519 forbid parameters; RSA requires NULL.
  if (keyType === "ec") return sequence(oid("1.2.840.10045.4.3.2"));
  if (keyType === "rsa")
    return sequence(oid("1.2.840.113549.1.1.11"), tlv(0x05, []));
  if (keyType === "ed25519") return sequence(oid("1.3.101.112"));
  throw new Error(
    `CertRequest supports ec, rsa, and ed25519 keys; got "${keyType}"`,
  );
};

const pemWrap = (der: Uint8Array): string => {
  const lines =
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
};

const buildCsr = (
  privateKeyPem: string,
  commonName: string | undefined,
  dnsNames: string[],
): string => {
  const key = NodeCrypto.createPrivateKey(privateKeyPem);
  const keyType = key.asymmetricKeyType ?? "unknown";
  const spki = NodeCrypto.createPublicKey(key).export({
    type: "spki",
    format: "der",
  });
  const info = sequence(
    tlv(0x02, [0x00]),
    subjectName(commonName),
    new Uint8Array(spki),
    attributes(dnsNames),
  );
  const signature = NodeCrypto.sign(
    keyType === "ed25519" ? null : "sha256",
    info,
    key,
  );
  return pemWrap(
    sequence(
      info,
      signatureAlgorithm(keyType),
      tlv(0x03, concatBytes([0x00], signature)),
    ),
  );
};

const keyFingerprint = (privateKeyPem: string): string =>
  NodeCrypto.createHash("sha256")
    .update(
      NodeCrypto.createPublicKey(privateKeyPem).export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("hex");

const keyPem = (privateKey: Redacted.Redacted<string> | string): string =>
  typeof privateKey === "string" ? privateKey : Redacted.value(privateKey);

const sameNames = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((name, i) => name === b[i]);

export const CertRequestProvider = () =>
  Provider.succeed(CertRequest, {
    reconcile: Effect.fn(function* ({ news, output }) {
      // Observe — there is no remote state; the persisted CSR is
      // authoritative as long as it was generated for the same key and
      // names (signatures are randomized, so regeneration is never
      // byte-stable and would churn downstream certificates).
      const pem = keyPem(news.privateKey);
      const fingerprint = yield* Effect.sync(() => keyFingerprint(pem));
      const dnsNames = news.dnsNames ?? [];
      if (
        output !== undefined &&
        output.keyFingerprint === fingerprint &&
        output.commonName === news.commonName &&
        sameNames(output.dnsNames, dnsNames)
      ) {
        return output;
      }

      // Ensure — key or names changed (or first reconcile): mint a fresh
      // CSR. Downstream certificate resources see the new `csr` value and
      // reissue on their own terms.
      const csr = yield* Effect.sync(() =>
        buildCsr(pem, news.commonName, dnsNames),
      );
      return {
        csr,
        keyFingerprint: fingerprint,
        commonName: news.commonName,
        dnsNames,
      };
    }),
    delete: Effect.fn(function* () {
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    // Non-listable: the CSR is generated client-side and lives only in
    // alchemy state. There is no remote service to enumerate.
    list: () => Effect.succeed([]),
  });
