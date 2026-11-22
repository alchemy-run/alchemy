import * as crypto from "node:crypto";
import { CA_KEY_PEM, CA_SUBJECT_CN } from "./certificate-pem.ts";

/**
 * Minimal X.509 issuer for `MergeCertificate`'s test: signs the CSR Key
 * Vault returns for a pending certificate (`issuer: { name: "Unknown" }`)
 * with the checked-in test CA key, so the vault can merge it. CPU-only;
 * call it inside `Effect.sync`.
 */

/** One DER element at `offset`: where it starts, where its content starts, where it ends. */
const element = (der: Uint8Array, offset: number) => {
  let length = der[offset + 1]!;
  let header = 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + der[offset + 2 + i]!;
    header += bytes;
  }
  return { start: offset, content: offset + header, end: offset + header + length };
};

const lengthBytes = (length: number): number[] => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return [0x80 | bytes.length, ...bytes];
};

const encode = (tag: number, ...parts: Uint8Array[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag, ...lengthBytes(body.length)]), body]);
};

/** AlgorithmIdentifier `sha256WithRSAEncryption` with NULL parameters. */
const SHA256_WITH_RSA = Buffer.from("300d06092a864886f70d01010b0500", "hex");

/** `YYMMDDHHMMSSZ` */
const utcTime = (date: Date) =>
  encode(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));

/** `CN=<cn>` as an X.501 Name. */
const commonName = (cn: string) =>
  encode(
    0x30,
    encode(0x31, encode(0x30, Buffer.from("0603550403", "hex"), encode(0x0c, Buffer.from(cn)))),
  );

/**
 * Issue a certificate for a base64 PKCS#10 CSR, valid for one day, signed by
 * the test CA. Returns the certificate's base64 DER and its SHA-1
 * thumbprint (base64url, Key Vault's `x5t`).
 */
export const signCsr = (csrBase64: string) => {
  const csr = Buffer.from(csrBase64, "base64");
  const request = element(csr, 0);
  const info = element(csr, request.content);
  const version = element(csr, info.content);
  const subject = element(csr, version.end);
  const publicKey = element(csr, subject.end);

  const serial = crypto.randomBytes(8);
  serial[0] = serial[0]! & 0x7f;
  const now = Date.now();
  const tbs = encode(
    0x30,
    Buffer.from("a003020102", "hex"),
    encode(0x02, serial),
    SHA256_WITH_RSA,
    commonName(CA_SUBJECT_CN),
    encode(0x30, utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    csr.subarray(subject.start, subject.end),
    csr.subarray(publicKey.start, publicKey.end),
  );
  const signature = crypto.sign("sha256", tbs, CA_KEY_PEM);
  const certificate = encode(0x30, tbs, SHA256_WITH_RSA, encode(0x03, Buffer.from([0]), signature));
  return {
    x5c: certificate.toString("base64"),
    x5t: crypto.createHash("sha1").update(certificate).digest("base64url"),
  };
};
