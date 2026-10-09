import * as NodeCrypto from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Base64, Hex } from "effect/encoding";
import * as Redacted from "effect/Redacted";
import * as Provider from "./Provider.ts";
import { Resource } from "./Resource.ts";
import * as Der from "./Util/Der.ts";
import { arrayEqualsUnordered } from "./Util/equal.ts";

/**
 * The private key cannot be parsed, its type is not supported, or a DNS
 * name is not a valid hostname.
 */
export class CertRequestError extends Data.TaggedError("CertRequestError")<{
  message: string;
  cause?: unknown;
}> {}

export interface CertRequestProps {
  /**
   * PEM-encoded private key (`pkcs8`, `sec1` or `pkcs1`) of type `ec`, `rsa`
   * or `ed25519`, such as the private key of a {@link KeyPair}. The key is
   * not included in the CSR or in the attributes.
   */
  privateKey: Redacted.Redacted<string> | string;
  /**
   * Subject common name (`CN=`). When omitted or empty the CSR has an empty
   * subject, which is enough for CAs that read hostnames from the request,
   * such as Cloudflare Origin CA.
   */
  commonName?: string;
  /**
   * DNS names for the `subjectAltName` extension: ASCII hostnames (RFC
   * 1123), optionally with a leading `*.` wildcard label. Encode
   * international names with punycode.
   */
  dnsNames?: string[];
}

export type CertRequest = Resource<
  "Alchemy.CertRequest",
  CertRequestProps,
  {
    /** The PKCS#10 certificate signing request, PEM-encoded. */
    csr: string;
    /** SHA-256 hex digest of the public key (SPKI DER). It changes with the key. */
    keyFingerprint: string;
    /** Subject common name the CSR was generated with. */
    commonName: string | undefined;
    /** `subjectAltName` DNS names the CSR was generated with. */
    dnsNames: string[];
  }
>;

/**
 * A PKCS#10 certificate signing request built locally from a private key,
 * usually one minted by {@link KeyPair}. Pass `csr` to a certificate
 * resource such as `Cloudflare.OriginCaCertificate`.
 *
 * ECDSA and RSA signatures are randomized, so signing the same request
 * twice yields different bytes. The CSR is therefore built once and kept in
 * state; it is built again only when the key, the common name or the DNS
 * names change.
 *
 * ### Generating a CSR
 * **Example:** CSR for a Cloudflare Origin CA certificate
 * ```typescript
 * const key = yield* KeyPair("origin-key", { algorithm: "ec" });
 * const request = yield* CertRequest("origin-csr", {
 *   privateKey: key.privateKey,
 *   commonName: "example.com",
 *   dnsNames: ["example.com", "*.example.com"],
 * });
 * const cert = yield* Cloudflare.OriginCaCertificate.OriginCaCertificate("origin-cert", {
 *   csr: request.csr,
 *   hostnames: ["example.com", "*.example.com"],
 *   requestType: "origin-ecc",
 * });
 * ```
 *
 * @resource
 */
export const CertRequest = Resource<CertRequest>("Alchemy.CertRequest");

type KeyType = "ec" | "rsa" | "ed25519";

interface SigningKey {
  readonly key: NodeCrypto.KeyObject;
  readonly type: KeyType;
  readonly spki: Uint8Array;
  readonly fingerprint: string;
}

interface RequestedNames {
  readonly commonName: string | undefined;
  readonly dnsNames: string[];
}

const OID = {
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  extensionRequest: "1.2.840.113549.1.9.14",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  ed25519: "1.3.101.112",
} as const;

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const MAX_HOSTNAME_LENGTH = 253;

const isHostname = (name: string): boolean => {
  if (name.length === 0 || name.length > MAX_HOSTNAME_LENGTH) return false;
  const hostname = name.startsWith("*.") ? name.slice(2) : name;
  return hostname.split(".").every((label) => HOSTNAME_LABEL.test(label));
};

const describeInvalidDnsName = (name: string): string => {
  if (!/^\p{ASCII}*$/u.test(name)) {
    return `dnsNames must be ASCII hostnames (punycode-encode IDNs): "${name}"`;
  }
  if (name.trim().length === 0) {
    return "dnsNames must not contain empty names";
  }
  return `dnsNames must be valid hostnames: "${name}"`;
};

const validateDnsNames = (dnsNames: readonly string[]): Effect.Effect<void, CertRequestError> => {
  const invalid = dnsNames.find((name) => !isHostname(name));
  return invalid === undefined
    ? Effect.void
    : new CertRequestError({ message: describeInvalidDnsName(invalid) });
};

const requestedNames = Effect.fn(function* (props: CertRequestProps) {
  const dnsNames = props.dnsNames ?? [];
  yield* validateDnsNames(dnsNames);
  return { commonName: props.commonName || undefined, dnsNames } satisfies RequestedNames;
});

const isKeyType = (type: string | undefined): type is KeyType =>
  type === "ec" || type === "rsa" || type === "ed25519";

const pemOf = (privateKey: Redacted.Redacted<string> | string): string =>
  Redacted.isRedacted(privateKey) ? Redacted.value(privateKey) : privateKey;

const spkiOf = (key: NodeCrypto.KeyObject): Uint8Array =>
  NodeCrypto.createPublicKey(key).export({ type: "spki", format: "der" });

const sha256Hex = (bytes: Uint8Array): string =>
  Hex.encode(NodeCrypto.createHash("sha256").update(bytes).digest());

const loadSigningKey = Effect.fn(function* (privateKey: Redacted.Redacted<string> | string) {
  const key = yield* Effect.try({
    try: () => NodeCrypto.createPrivateKey(pemOf(privateKey)),
    catch: (cause) =>
      new CertRequestError({ message: "Cannot parse privateKey as a PEM private key.", cause }),
  });
  const type = key.asymmetricKeyType;
  if (!isKeyType(type)) {
    return yield* new CertRequestError({
      message: `CertRequest supports ec, rsa and ed25519 keys; got "${type ?? "unknown"}".`,
    });
  }
  const spki = yield* Effect.sync(() => spkiOf(key));
  const fingerprint = yield* Effect.sync(() => sha256Hex(spki));
  return { key, type, spki, fingerprint } satisfies SigningKey;
});

const subjectName = (commonName: string | undefined): Uint8Array =>
  commonName === undefined
    ? Der.sequence()
    : Der.sequence(Der.set(Der.sequence(Der.oid(OID.commonName), Der.utf8String(commonName))));

const dnsName = (name: string): Uint8Array =>
  Der.contextPrimitive(2, new TextEncoder().encode(name));

const extensionRequest = (dnsNames: string[]): Uint8Array => {
  if (dnsNames.length === 0) return Der.contextTag(0, new Uint8Array());
  const subjectAltName = Der.sequence(
    Der.oid(OID.subjectAltName),
    Der.octetString(Der.sequence(...dnsNames.map(dnsName))),
  );
  return Der.contextTag(
    0,
    Der.sequence(Der.oid(OID.extensionRequest), Der.set(Der.sequence(subjectAltName))),
  );
};

const signatureAlgorithm = (type: KeyType): Uint8Array => {
  switch (type) {
    case "ec":
      return Der.sequence(Der.oid(OID.ecdsaWithSha256));
    case "rsa":
      return Der.sequence(Der.oid(OID.sha256WithRsa), Der.nullValue());
    case "ed25519":
      return Der.sequence(Der.oid(OID.ed25519));
  }
};

const digestOf = (type: KeyType): "sha256" | null => (type === "ed25519" ? null : "sha256");

const toPem = (der: Uint8Array): string => {
  const lines = Base64.encode(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
};

const signRequest = (signingKey: SigningKey, names: RequestedNames): string => {
  const info = Der.sequence(
    Der.integer(0),
    subjectName(names.commonName),
    signingKey.spki,
    extensionRequest(names.dnsNames),
  );
  const signature = NodeCrypto.sign(digestOf(signingKey.type), info, signingKey.key);
  return toPem(Der.sequence(info, signatureAlgorithm(signingKey.type), Der.bitString(signature)));
};

const isUnchanged = (
  output: CertRequest["Attributes"] | undefined,
  signingKey: SigningKey,
  names: RequestedNames,
): output is CertRequest["Attributes"] =>
  output !== undefined &&
  output.keyFingerprint === signingKey.fingerprint &&
  output.commonName === names.commonName &&
  arrayEqualsUnordered(output.dnsNames, names.dnsNames);

export const CertRequestProvider = () =>
  Provider.succeed(CertRequest, {
    reconcile: Effect.fn(function* ({ news, output }) {
      const names = yield* requestedNames(news);
      const signingKey = yield* loadSigningKey(news.privateKey);
      // Signatures are randomized: keep the stored CSR while its inputs stand.
      if (isUnchanged(output, signingKey, names)) {
        return output;
      }
      const csr = yield* Effect.try({
        try: () => signRequest(signingKey, names),
        catch: (cause) =>
          new CertRequestError({ message: "Cannot sign the certificate request.", cause }),
      });
      return { csr, keyFingerprint: signingKey.fingerprint, ...names };
    }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
    list: () => Effect.succeed([]),
  });
