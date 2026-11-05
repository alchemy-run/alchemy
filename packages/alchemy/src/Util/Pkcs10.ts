/**
 * PKCS#10 certificate request encoding (RFC 2986) over the DER codec in
 * `./Der.ts`. Signing is left to the caller, so the same encoding serves
 * `node:crypto` at deploy time and WebCrypto on workerd.
 *
 * @internal
 */
import * as Der from "./Der.ts";

const OID = {
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  extensionRequest: "1.2.840.113549.1.9.14",
} as const;

export interface Subject {
  /** Subject `CN`. Omitted, the subject is empty. */
  readonly commonName?: string | undefined;
  /** `subjectAltName` dNSName entries. */
  readonly dnsNames: ReadonlyArray<string>;
}

export const ecdsaWithSha256 = Der.sequence(Der.oid("1.2.840.10045.4.3.2"));
export const sha256WithRsa = Der.sequence(Der.oid("1.2.840.113549.1.1.11"), Der.nullValue());
export const ed25519 = Der.sequence(Der.oid("1.3.101.112"));

const subjectName = (commonName: string | undefined) =>
  commonName === undefined
    ? Der.sequence()
    : Der.sequence(Der.set(Der.sequence(Der.oid(OID.commonName), Der.utf8String(commonName))));

const dnsName = (name: string) => Der.contextPrimitive(2, new TextEncoder().encode(name));

const subjectAltName = (dnsNames: ReadonlyArray<string>) =>
  Der.sequence(
    Der.oid(OID.subjectAltName),
    Der.octetString(Der.sequence(...dnsNames.map(dnsName))),
  );

const attributes = (dnsNames: ReadonlyArray<string>) =>
  Der.contextTag(
    0,
    dnsNames.length === 0
      ? new Uint8Array()
      : Der.sequence(
          Der.oid(OID.extensionRequest),
          Der.set(Der.sequence(subjectAltName(dnsNames))),
        ),
  );

/** The `CertificationRequestInfo` to sign, for the public key `spki` (DER). */
export const requestInfo = (spki: Uint8Array, subject: Subject): Uint8Array =>
  Der.sequence(Der.integer(0), subjectName(subject.commonName), spki, attributes(subject.dnsNames));

/** The signed `CertificationRequest`, DER. */
export const certificationRequest = (
  info: Uint8Array,
  signatureAlgorithm: Uint8Array,
  signature: Uint8Array,
): Uint8Array => Der.sequence(info, signatureAlgorithm, Der.bitString(signature));
