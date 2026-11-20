import * as NodeCrypto from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Redacted from "effect/Redacted";
import * as Provider from "./Provider.ts";
import { Resource } from "./Resource.ts";
import { arrayEqualsUnordered } from "./Util/equal.ts";
import * as Pkcs10 from "./Util/Pkcs10.ts";
import { sha256 } from "./Util/sha256.ts";

/** A CertRequest cannot be built from its props. */
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
    /** SHA-256 hex digest of the public key (SPKI DER). */
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

const signatureSchemes = {
  ec: { digest: "sha256", algorithm: Pkcs10.ecdsaWithSha256 },
  rsa: { digest: "sha256", algorithm: Pkcs10.sha256WithRsa },
  // Ed25519 hashes internally, so Node takes no digest for it.
  ed25519: { digest: null, algorithm: Pkcs10.ed25519 },
} as const;

type KeyType = keyof typeof signatureSchemes;

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

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const MAX_DNS_NAME_LENGTH = 253;

const isDnsName = (name: string): boolean =>
  name.length <= MAX_DNS_NAME_LENGTH &&
  name
    .replace(/^\*\./, "")
    .split(".")
    .every((label) => DNS_LABEL.test(label));

const describeInvalidDnsName = (name: string): string => {
  if (!/^\p{ASCII}*$/u.test(name)) {
    return `dnsNames must be ASCII hostnames (punycode-encode IDNs): "${name}"`;
  }
  if (name.trim().length === 0) {
    return "dnsNames must not contain empty names";
  }
  return `dnsNames must be valid hostnames: "${name}"`;
};

const parseNames = (props: CertRequestProps): Effect.Effect<RequestedNames, CertRequestError> => {
  const dnsNames = props.dnsNames ?? [];
  const invalidName = dnsNames.find((name) => !isDnsName(name));
  return invalidName === undefined
    ? Effect.succeed({ commonName: props.commonName || undefined, dnsNames })
    : Effect.fail(new CertRequestError({ message: describeInvalidDnsName(invalidName) }));
};

const isKeyType = (type: string | undefined): type is KeyType =>
  type !== undefined && Object.hasOwn(signatureSchemes, type);

const parsePrivateKey = (privateKey: Redacted.Redacted<string> | string) =>
  Effect.try({
    try: () =>
      NodeCrypto.createPrivateKey(
        Redacted.isRedacted(privateKey) ? Redacted.value(privateKey) : privateKey,
      ),
    catch: (cause) =>
      new CertRequestError({ message: "Cannot parse privateKey as a PEM private key.", cause }),
  });

const loadSigningKey = Effect.fn(function* (privateKey: Redacted.Redacted<string> | string) {
  const key = yield* parsePrivateKey(privateKey);
  const type = key.asymmetricKeyType;
  if (!isKeyType(type)) {
    return yield* new CertRequestError({
      message: `CertRequest supports ${Object.keys(signatureSchemes).join(", ")} keys; got "${type ?? "unknown"}".`,
    });
  }
  const spki = yield* Effect.sync(() =>
    NodeCrypto.createPublicKey(key).export({ type: "spki", format: "der" }),
  );
  return { key, type, spki, fingerprint: yield* sha256(spki) } satisfies SigningKey;
});

const toPem = (der: Uint8Array): string => {
  const lines = Base64.encode(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
};

const sign = (signingKey: SigningKey, data: Uint8Array) =>
  Effect.try({
    try: () => NodeCrypto.sign(signatureSchemes[signingKey.type].digest, data, signingKey.key),
    catch: (cause) =>
      new CertRequestError({ message: "Cannot sign the certificate request.", cause }),
  });

const signRequest = Effect.fn(function* (signingKey: SigningKey, names: RequestedNames) {
  const info = Pkcs10.requestInfo(signingKey.spki, names);
  const signature = yield* sign(signingKey, info);
  const { algorithm } = signatureSchemes[signingKey.type];
  return toPem(Pkcs10.certificationRequest(info, algorithm, signature));
});

const wasBuiltFrom = (
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
      const names = yield* parseNames(news);
      const signingKey = yield* loadSigningKey(news.privateKey);
      if (wasBuiltFrom(output, signingKey, names)) return output;
      const csr = yield* signRequest(signingKey, names);
      return { csr, keyFingerprint: signingKey.fingerprint, ...names };
    }),
    delete: () => Effect.void,
  });
