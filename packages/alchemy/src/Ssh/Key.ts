import { generateKeyPairSync } from "node:crypto";
import * as Effect from "effect/Effect";

const u32be = (n: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n);
  return buf;
};

const sshString = (data: Buffer | string) => {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([u32be(buf.length), buf]);
};

/**
 * Encode an ed25519 keypair as OpenSSH public + private key files.
 * `ssh -i` on macOS rejects PKCS8 ed25519 PEMs with exit 255.
 */
const encodeOpenSshEd25519 = (
  publicRaw: Buffer,
  seed: Buffer,
  comment: string,
) => {
  const algo = Buffer.from("ssh-ed25519");
  const pubBlob = Buffer.concat([sshString(algo), sshString(publicRaw)]);
  const publicKey = `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`;

  const check = Buffer.alloc(4);
  check.writeUInt32BE(0xa1b2c3d4);
  const secret = Buffer.concat([seed, publicRaw]);
  let inner = Buffer.concat([
    check,
    check,
    sshString(algo),
    sshString(publicRaw),
    sshString(secret),
    sshString(comment),
  ]);
  const padLen = (8 - (inner.length % 8)) % 8;
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  inner = Buffer.concat([inner, pad]);

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32be(1),
    sshString(pubBlob),
    sshString(inner),
  ]);
  const b64 = body.toString("base64");
  const wrapped = b64.match(/.{1,70}/g)?.join("\n") ?? b64;
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
  return { publicKey, privateKey };
};

/**
 * Generate an ed25519 keypair in OpenSSH format: `publicKey` is an
 * `authorized_keys` line and `privateKey` a file `ssh -i` accepts.
 */
export const generateKeyPair = (comment: string) =>
  Effect.sync(() => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ type: "spki", format: "der" });
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
    const publicRaw = spki.subarray(spki.length - 32);
    const seed = pkcs8.subarray(pkcs8.length - 32);
    return encodeOpenSshEd25519(publicRaw, seed, comment);
  });
