import * as NodeCrypto from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Provider from "./Provider.ts";
import { Resource } from "./Resource.ts";
import { arrayEqualsUnordered } from "./Util/equal.ts";

/**
 * The private key cannot be parsed, the key type is not supported, or a
 * DNS name is not valid.
 */
export class CertRequestError extends Data.TaggedError("CertRequestError")<{
  message: string;
  cause?: unknown;
}> {}

export interface CertRequestProps {
  /**
   * PEM-encoded private key. Accepted encodings: `pkcs8`, `sec1`, `pkcs1`.
   * Supported key types: `ec`, `rsa`, `ed25519`. Use the private key from
   * {@link KeyPair}. The key is not included in the CSR or in the
   * attributes.
   */
  privateKey: Redacted.Redacted<string> | string;
  /**
   * Subject common name (`CN=`). If omitted or empty, the CSR has an empty
   * subject. Cloudflare Origin CA reads hostnames from the API request, so
   * it does not need one.
   */
  commonName?: string;
  /**
   * DNS names for the `subjectAltName` extension. Each name must be an
   * ASCII hostname (RFC 1123). Encode international names with punycode.
   * A leading `*.` wildcard label is allowed. Omit for CAs that ignore CSR
   * names.
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
     * SHA-256 hex digest of the public key (SPKI DER). A different value
     * means the key changed.
     */
    keyFingerprint: string;
    /** Subject common name the CSR was generated with. */
    commonName: string | undefined;
    /** subjectAltName DNS names the CSR was generated with. */
    dnsNames: string[];
  }
>;

/**
 * A PKCS#10 certificate signing request. It is built locally from a private
 * key, usually one from {@link KeyPair}. Pass `csr` to a certificate
 * resource such as `Cloudflare.OriginCaCertificate`. The private key is
 * stored in state like every other prop.
 *
 * ECDSA and RSA signatures are random, so a new CSR differs from the last
 * one even for the same inputs. The CSR is built once and stored. It is
 * built again only when the key, the common name, or the DNS names change.
 *
 *
 * ### Generating a CSR
 * **Example:** CSR for a Cloudflare Origin CA certificate
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
 *
 * @resource
 */
export const CertRequest = Resource<CertRequest>("Alchemy.CertRequest");

const DER_INTEGER = 0x02;
const DER_BIT_STRING = 0x03;
const DER_OCTET_STRING = 0x04;
const DER_NULL = 0x05;
const DER_OID = 0x06;
const DER_UTF8_STRING = 0x0c;
const DER_SEQUENCE = 0x30;
const DER_SET = 0x31;
/** `[0] IMPLICIT` tag of the CSR attributes. */
const CSR_ATTRIBUTES = 0xa0;
/** `[2] IMPLICIT` tag of a `dNSName` GeneralName. */
const GENERAL_NAME_DNS = 0x82;

const CSR_VERSION = 0x00;
const BIT_STRING_NO_UNUSED_BITS = 0x00;

const OID_COMMON_NAME = "2.5.4.3";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";
const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_ED25519 = "1.3.101.112";

const concatBytes = (...parts: Array<Uint8Array | number[]>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
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
  tlv(DER_SEQUENCE, concatBytes(...parts));

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
  return tlv(
    DER_OID,
    [arcs[0] * 40 + arcs[1], ...arcs.slice(2)].flatMap(base128),
  );
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** IA5String is ASCII. `validateDnsNames` runs first and rejects non-ASCII names. */
const ia5 = (name: string): Uint8Array => utf8(name);

/** Subject: `CN=<commonName>`, or the empty DN when no name is given. */
const subjectDn = (commonName: string | undefined): Uint8Array => {
  if (commonName === undefined) return sequence();
  return sequence(
    tlv(
      DER_SET,
      sequence(oid(OID_COMMON_NAME), tlv(DER_UTF8_STRING, utf8(commonName))),
    ),
  );
};

const csrAttributes = (dnsNames: string[]): Uint8Array => {
  if (dnsNames.length === 0) return tlv(CSR_ATTRIBUTES, []);
  const generalNames = sequence(
    ...dnsNames.map((name) => tlv(GENERAL_NAME_DNS, ia5(name))),
  );
  const extension = sequence(
    oid(OID_SUBJECT_ALT_NAME),
    tlv(DER_OCTET_STRING, generalNames),
  );
  return tlv(
    CSR_ATTRIBUTES,
    sequence(oid(OID_EXTENSION_REQUEST), tlv(DER_SET, sequence(extension))),
  );
};

type SupportedKeyType = "ec" | "rsa" | "ed25519";

const isSupportedKeyType = (
  keyType: string | undefined,
): keyType is SupportedKeyType =>
  keyType === "ec" || keyType === "rsa" || keyType === "ed25519";

/** ECDSA and Ed25519 have no parameters. RSA needs a NULL parameter. */
const signatureAlgorithm = (keyType: SupportedKeyType): Uint8Array => {
  if (keyType === "ec") return sequence(oid(OID_ECDSA_WITH_SHA256));
  if (keyType === "rsa") {
    return sequence(oid(OID_SHA256_WITH_RSA), tlv(DER_NULL, []));
  }
  return sequence(oid(OID_ED25519));
};

const pemWrap = (der: Uint8Array): string => {
  const lines = Encoding.encodeBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
};

const exportPublicKeyDer = (key: NodeCrypto.KeyObject) =>
  NodeCrypto.createPublicKey(key).export({ type: "spki", format: "der" });

const buildCsr = (
  key: NodeCrypto.KeyObject,
  keyType: SupportedKeyType,
  commonName: string | undefined,
  dnsNames: string[],
): string => {
  const publicKeyDer = exportPublicKeyDer(key);
  const requestInfo = sequence(
    tlv(DER_INTEGER, [CSR_VERSION]),
    subjectDn(commonName),
    new Uint8Array(publicKeyDer),
    csrAttributes(dnsNames),
  );
  const signature = NodeCrypto.sign(
    keyType === "ed25519" ? null : "sha256",
    requestInfo,
    key,
  );
  return pemWrap(
    sequence(
      requestInfo,
      signatureAlgorithm(keyType),
      tlv(DER_BIT_STRING, concatBytes([BIT_STRING_NO_UNUSED_BITS], signature)),
    ),
  );
};

const computeKeyFingerprint = (key: NodeCrypto.KeyObject): string =>
  NodeCrypto.createHash("sha256").update(exportPublicKeyDer(key)).digest("hex");

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const MAX_HOSTNAME_LENGTH = 253;

/** RFC 1123 hostname, optionally with a leading wildcard label. */
const isHostname = (name: string): boolean => {
  if (name.length === 0 || name.length > MAX_HOSTNAME_LENGTH) return false;
  const labels = name.startsWith("*.")
    ? name.slice(2).split(".")
    : name.split(".");
  return labels.every((label) => HOSTNAME_LABEL.test(label));
};

const describeInvalidDnsName = (name: string): string => {
  if (!/^[\x00-\x7f]*$/.test(name)) {
    return `dnsNames must be ASCII hostnames (punycode-encode IDNs): "${name}"`;
  }
  if (name.trim().length === 0) {
    return "dnsNames must not contain empty names";
  }
  return `dnsNames must be valid hostnames: "${name}"`;
};

const validateDnsNames = (
  dnsNames: readonly string[],
): Effect.Effect<void, CertRequestError> => {
  const invalid = dnsNames.find((name) => !isHostname(name));
  if (invalid === undefined) return Effect.void;
  return new CertRequestError({ message: describeInvalidDnsName(invalid) });
};

const normalizeCommonName = (
  commonName: string | undefined,
): string | undefined => {
  if (commonName === undefined || commonName === "") return undefined;
  return commonName;
};

const isSameRequest = (
  output: CertRequest["Attributes"] | undefined,
  keyFingerprint: string,
  commonName: string | undefined,
  dnsNames: readonly string[],
): output is CertRequest["Attributes"] =>
  output !== undefined &&
  output.keyFingerprint === keyFingerprint &&
  output.commonName === commonName &&
  arrayEqualsUnordered(output.dnsNames, dnsNames);

export const CertRequestProvider = () =>
  Provider.succeed(CertRequest, {
    reconcile: Effect.fn(function* ({ news, output }) {
      const dnsNames = news.dnsNames ?? [];
      const commonName = normalizeCommonName(news.commonName);
      yield* validateDnsNames(dnsNames);
      const key = yield* Effect.try({
        try: () =>
          NodeCrypto.createPrivateKey(
            typeof news.privateKey === "string"
              ? news.privateKey
              : Redacted.value(news.privateKey),
          ),
        catch: (cause) =>
          new CertRequestError({
            message: "Cannot parse privateKey as a PEM private key.",
            cause,
          }),
      });
      const keyType = yield* Effect.try({
        try: () => key.asymmetricKeyType,
        catch: (cause) =>
          new CertRequestError({
            message: "Cannot determine the type of privateKey.",
            cause,
          }),
      });
      if (!isSupportedKeyType(keyType)) {
        return yield* new CertRequestError({
          message: `CertRequest supports ec, rsa, and ed25519 keys; got "${keyType ?? "unknown"}"`,
        });
      }
      const keyFingerprint = yield* Effect.try({
        try: () => computeKeyFingerprint(key),
        catch: (cause) =>
          new CertRequestError({
            message: "Cannot export the public key from privateKey.",
            cause,
          }),
      });

      // Signatures are random. Reuse the stored CSR when the inputs did not change.
      if (isSameRequest(output, keyFingerprint, commonName, dnsNames)) {
        return output;
      }

      const csr = yield* Effect.try({
        try: () => buildCsr(key, keyType, commonName, dnsNames),
        catch: (cause) =>
          new CertRequestError({ message: "Cannot build the CSR.", cause }),
      });
      return { csr, keyFingerprint, commonName, dnsNames };
    }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
    list: () => Effect.succeed([]),
  });
