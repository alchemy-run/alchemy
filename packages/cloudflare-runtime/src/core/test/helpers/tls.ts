import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import * as NodeHttps from "node:https";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// A private CA and a server certificate under it, made in the test. No library
// in the repo builds certificates, and the platform verifiers workerd uses
// reject a server certificate valid for more than 398 days (macOS) or one that
// has expired, so a checked-in one would stop working. This writes the little
// DER an ECDSA P-256 CA and an end-entity certificate need, signed by Node.

const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const set = (...parts: Buffer[]) => der(0x31, ...parts);
const bitString = (bytes: Buffer, unusedBits = 0) => der(0x03, Buffer.from([unusedBits]), bytes);
const octetString = (bytes: Buffer) => der(0x04, bytes);
const boolean = (value: boolean) => der(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8String = (text: string) => der(0x0c, Buffer.from(text));
const utcTime = (date: Date) =>
  der(0x17, Buffer.from(date.toISOString().replace(/^20|[-:T]|\.\d+/g, "")));
const integer = (bytes: Buffer) =>
  der(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.alloc(1), bytes]) : bytes);
const oid = (dotted: string) => {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const arcs = [first! * 40 + second!, ...rest].flatMap((arc) => {
    const bytes = [arc & 0x7f];
    for (let rem = arc >> 7; rem > 0; rem >>= 7) bytes.unshift((rem & 0x7f) | 0x80);
    return bytes;
  });
  return der(0x06, Buffer.from(arcs));
};
const extension = (id: string, critical: boolean, value: Buffer) =>
  sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
const distinguishedName = (commonName: string) =>
  sequence(set(sequence(oid("2.5.4.3"), utf8String(commonName))));

const pem = (label: string, bytes: Buffer) =>
  `-----BEGIN ${label}-----\n${bytes.toString("base64").replace(/.{1,64}/g, "$&\n")}-----END ${label}-----\n`;

const certificate = (input: {
  readonly subject: string;
  readonly issuer: string;
  readonly publicKey: KeyObject;
  readonly signingKey: KeyObject;
  readonly extensions: ReadonlyArray<Buffer>;
}) => {
  const now = Date.now();
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const ecdsaWithSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ecdsaWithSha256,
    distinguishedName(input.issuer),
    // A day either side of now: far inside every verifier's limits.
    sequence(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
    distinguishedName(input.subject),
    input.publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(...input.extensions)),
  );
  return sequence(tbs, ecdsaWithSha256, bitString(sign("sha256", tbs, input.signingKey)));
};

export interface Pki {
  /** The CA certificate, as PEM: what a client has to trust. */
  readonly ca: string;
  /** A certificate for `127.0.0.1` and `localhost` signed by the CA, and its key, as PEM. */
  readonly server: { readonly certificate: string; readonly key: string };
}

/** A new CA, valid for a few days, and a server certificate under it. */
export const makePki = (commonName: string): Pki => {
  const ca = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const server = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caName = `${commonName} test CA`;
  const authority = certificate({
    subject: caName,
    issuer: caName,
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    extensions: [
      extension("2.5.29.19", true, sequence(boolean(true))), // basicConstraints: CA
      extension("2.5.29.15", true, bitString(Buffer.from([0x06]), 1)), // keyCertSign, cRLSign
    ],
  });
  const leaf = certificate({
    subject: "localhost",
    issuer: caName,
    publicKey: server.publicKey,
    signingKey: ca.privateKey,
    extensions: [
      extension("2.5.29.19", true, sequence()), // basicConstraints: not a CA
      extension("2.5.29.15", true, bitString(Buffer.from([0x80]), 7)), // digitalSignature
      extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))), // serverAuth
      extension(
        "2.5.29.17", // subjectAltName
        false,
        sequence(der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1]))),
      ),
    ],
  });
  return {
    ca: pem("CERTIFICATE", authority),
    server: {
      certificate: pem("CERTIFICATE", leaf),
      key: server.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
  };
};

/** An HTTPS server on 127.0.0.1 answering every request with `body`; closed with the scope. */
export const serveHttps = (pki: Pki, body: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttps.Server>((resume) => {
      const server = NodeHttps.createServer(
        { cert: pki.server.certificate, key: pki.server.key },
        (_request, response) => response.end(body),
      );
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen({ port: 0, host: "127.0.0.1" }, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  ).pipe(
    Effect.map((server) => {
      const { port } = server.address() as { port: number };
      return `https://127.0.0.1:${port}/`;
    }),
  );

/** A path in a temp directory, removed with the scope; the file is not created. */
export const tempPath = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "cloudflare-runtime-tls-" }), name);
});
