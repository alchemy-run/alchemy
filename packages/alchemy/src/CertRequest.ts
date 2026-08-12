import * as NodeCrypto from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Provider from "./Provider.ts";
import { Resource } from "./Resource.ts";

/**
 * CSR generation failed: the private key is unparseable or of an
 * unsupported type, or a requested DNS name is invalid.
 */
export class CertRequestError extends Data.TaggedError("CertRequestError")<{
  message: string;
  cause?: unknown;
}> {}

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
     * SHA-256 hex digest of the key's SPKI (public half). Identifies which
     * key the persisted CSR was generated for, so a key rotation is
     * detectable without comparing the key itself.
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
 * CSRs (e.g. `Cloudflare.OriginCaCertificate`). Downstream resources
 * consume the CSR; `privateKey` is persisted in state like any other prop,
 * encrypted at rest only if the state store encrypts.
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

const base128 = (value: number): number[] => {
  const bytes: number[] = [];
  for (let v = value; ; v = Math.floor(v / 128)) {
    bytes.unshift(v % 128);
    if (v < 128) break;
  }
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
};

const oid = (dotted: string): Uint8Array => {
  const arcs = dotted.split(".").map(Number);
  return tlv(0x06, [arcs[0] * 40 + arcs[1], ...arcs.slice(2)].flatMap(base128));
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** IA5String bytes; ASCII-ness is checked by {@link nonAsciiDnsName}. */
const ia5 = (name: string): Uint8Array => utf8(name);

/** Subject: `CN=<commonName>`, or the empty DN when no name is given. */
const subjectDn = (commonName: string | undefined): Uint8Array =>
  commonName === undefined
    ? sequence()
    : sequence(
        tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, utf8(commonName)))),
      );

/**
 * `[0] IMPLICIT` CSR attributes: a PKCS#9 `extensionRequest` carrying a
 * `subjectAltName` of dNSNames, or empty when no names are requested.
 */
const csrAttributes = (dnsNames: string[]): Uint8Array => {
  if (dnsNames.length === 0) return tlv(0xa0, []);
  const generalNames = sequence(
    ...dnsNames.map((name) => tlv(0x82, ia5(name))),
  );
  const extension = sequence(oid("2.5.29.17"), tlv(0x04, generalNames));
  return tlv(
    0xa0,
    sequence(oid("1.2.840.113549.1.9.14"), tlv(0x31, sequence(extension))),
  );
};

type SupportedKeyType = "ec" | "rsa" | "ed25519";

const isSupportedKeyType = (
  keyType: string | undefined,
): keyType is SupportedKeyType =>
  keyType === "ec" || keyType === "rsa" || keyType === "ed25519";

/** ecdsa-with-SHA256 and Ed25519 forbid parameters; RSA requires NULL. */
const signatureAlgorithm = (keyType: SupportedKeyType): Uint8Array =>
  keyType === "ec"
    ? sequence(oid("1.2.840.10045.4.3.2"))
    : keyType === "rsa"
      ? sequence(oid("1.2.840.113549.1.1.11"), tlv(0x05, []))
      : sequence(oid("1.3.101.112"));

const pemWrap = (der: Uint8Array): string => {
  const lines = Encoding.encodeBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
};

const buildCsr = (
  key: NodeCrypto.KeyObject,
  keyType: SupportedKeyType,
  commonName: string | undefined,
  dnsNames: string[],
): string => {
  const spki = NodeCrypto.createPublicKey(key).export({
    type: "spki",
    format: "der",
  });
  const info = sequence(
    tlv(0x02, [0x00]),
    subjectDn(commonName),
    new Uint8Array(spki),
    csrAttributes(dnsNames),
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

const computeKeyFingerprint = (key: NodeCrypto.KeyObject): string =>
  NodeCrypto.createHash("sha256")
    .update(
      NodeCrypto.createPublicKey(key).export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("hex");

/** IA5String admits only ASCII — IDNs must arrive punycode-encoded. */
const nonAsciiDnsName = (dnsNames: readonly string[]): string | undefined =>
  dnsNames.find((name) => !/^[\x00-\x7f]*$/.test(name));

const sameNames = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((name, i) => name === b[i]);

export const CertRequestProvider = () =>
  Provider.succeed(CertRequest, {
    reconcile: Effect.fn(function* ({ news, output }) {
      const dnsNames = news.dnsNames ?? [];
      const nonAscii = nonAsciiDnsName(dnsNames);
      if (nonAscii !== undefined) {
        return yield* new CertRequestError({
          message: `dnsNames must be ASCII (punycode-encode IDNs): "${nonAscii}"`,
        });
      }
      const key = yield* Effect.try({
        try: () =>
          NodeCrypto.createPrivateKey(
            typeof news.privateKey === "string"
              ? news.privateKey
              : Redacted.value(news.privateKey),
          ),
        catch: (cause) =>
          new CertRequestError({
            message: "privateKey is not a parseable PEM private key",
            cause,
          }),
      });
      const keyType = key.asymmetricKeyType;
      if (!isSupportedKeyType(keyType)) {
        return yield* new CertRequestError({
          message: `CertRequest supports ec, rsa, and ed25519 keys; got "${keyType ?? "unknown"}"`,
        });
      }

      // Observe — there is no remote state; the persisted CSR is
      // authoritative as long as it was generated for the same key and
      // names (signatures are randomized, so regeneration is never
      // byte-stable and would churn downstream certificates).
      const fingerprint = computeKeyFingerprint(key);
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
      const csr = yield* Effect.try({
        try: () => buildCsr(key, keyType, news.commonName, dnsNames),
        catch: (cause) =>
          new CertRequestError({ message: "CSR generation failed", cause }),
      });
      return {
        csr,
        keyFingerprint: fingerprint,
        commonName: news.commonName,
        dnsNames,
      };
    }),
    // Nothing to delete — the CSR only ever existed in state.
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
    // Non-listable: the CSR is generated client-side and lives only in
    // alchemy state. There is no remote service to enumerate.
    list: () => Effect.succeed([]),
  });
