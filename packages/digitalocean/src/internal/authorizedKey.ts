import { createHash, createPublicKey } from "node:crypto";
import { Base64 } from "effect/encoding";
import * as Option from "effect/Option";

/** A public key as DigitalOcean registers it. */
export interface AuthorizedKey {
  /** The `authorized_keys` line. */
  readonly line: string;
  /** The MD5 of the key material in colon-separated hex, as DigitalOcean computes it. */
  readonly fingerprint: string;
}

const PEM = /^-----BEGIN /;

const PUBLIC_KEY_PEM = /^-----BEGIN (RSA )?PUBLIC KEY-----/;

const NIST_CURVES: Partial<Record<string, string>> = {
  "P-256": "nistp256",
  "P-384": "nistp384",
  "P-521": "nistp521",
};

const sshString = (bytes: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

// A leading zero keeps a high first bit from reading as negative.
const sshMpint = (bytes: Buffer) =>
  sshString(
    bytes[0] !== undefined && bytes[0] & 0x80 ? Buffer.concat([Buffer.of(0), bytes]) : bytes,
  );

const fromBase64Url = (value: string) => Buffer.from(value, "base64url");

const openSshLine = (type: string, ...fields: Buffer[]) =>
  `${type} ${Buffer.concat([sshString(Buffer.from(type)), ...fields]).toString("base64")}`;

// Wire formats from RFC 8709 (ed25519), RFC 4253 (rsa) and RFC 5656 (ecdsa).
const openSshFromJwk = (jwk: JsonWebKey): Option.Option<string> => {
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x !== undefined) {
    return Option.some(openSshLine("ssh-ed25519", sshString(fromBase64Url(jwk.x))));
  }
  if (jwk.kty === "RSA" && jwk.n !== undefined && jwk.e !== undefined) {
    return Option.some(
      openSshLine("ssh-rsa", sshMpint(fromBase64Url(jwk.e)), sshMpint(fromBase64Url(jwk.n))),
    );
  }
  const curve = jwk.kty === "EC" && jwk.crv !== undefined ? NIST_CURVES[jwk.crv] : undefined;
  if (curve !== undefined && jwk.x !== undefined && jwk.y !== undefined) {
    const point = Buffer.concat([Buffer.of(4), fromBase64Url(jwk.x), fromBase64Url(jwk.y)]);
    return Option.some(
      openSshLine(`ecdsa-sha2-${curve}`, sshString(Buffer.from(curve)), sshString(point)),
    );
  }
  return Option.none();
};

const exportJwk = Option.liftThrowable((pem: string) =>
  createPublicKey(pem).export({ format: "jwk" }),
);

const pemToLine = (pem: string) =>
  PUBLIC_KEY_PEM.test(pem) ? Option.flatMap(exportJwk(pem), openSshFromJwk) : Option.none();

const toLine = (publicKey: string) =>
  PEM.test(publicKey) ? pemToLine(publicKey) : Option.some(publicKey);

const materialOf = (line: string) =>
  Option.fromNullishOr(line.split(/\s+/)[1]).pipe(
    Option.flatMap((field) => Option.getSuccess(Base64.decode(field))),
  );

const md5Fingerprint = (material: Uint8Array) =>
  Array.from(createHash("md5").update(material).digest(), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(":");

/**
 * Parses an `authorized_keys` line, or a PEM public key such as `KeyPair`
 * produces. Anything else, a private key included, is `None`.
 */
export const parseAuthorizedKey = (publicKey: string): Option.Option<AuthorizedKey> =>
  Option.gen(function* () {
    const line = yield* toLine(publicKey.trim());
    const material = yield* materialOf(line);
    return { line, fingerprint: md5Fingerprint(material) };
  });
