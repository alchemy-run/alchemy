/**
 * A per-sandbox certificate authority for the egress proxy (DESIGN.md §8).
 *
 * The proxy terminates TLS for hosts that have egress routes, so it must
 * present a certificate the sandbox's tools trust. Each sandbox mints its own
 * CA at boot: ECDSA P-256 over WebCrypto, the private key non-extractable and
 * held in memory only. Nothing outside the process can sign with it, and it
 * dies with the process.
 */
// `@peculiar/x509` resolves its algorithms through tsyringe, which needs the
// Reflect metadata polyfill loaded first.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/** Minting the CA or a leaf failed (WebCrypto or encoding). */
export class CaError extends Data.TaggedError("EgressCaError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A leaf certificate and its key, PEM-encoded for `node:tls`. */
export interface Leaf {
  readonly cert: string;
  readonly key: string;
}

export interface LocalCa {
  /** The CA certificate, PEM. Tools in the sandbox trust this. */
  readonly pem: string;
  /**
   * A leaf for `host` (a DNS name, or an IP literal), signed by this CA.
   * Cached per host; concurrent first requests for a host mint once.
   */
  readonly leafFor: (host: string) => Effect.Effect<Leaf, CaError>;
}

const SIGNING = { name: "ECDSA", hash: "SHA-256" } as const;
const KEY = { name: "ECDSA", namedCurve: "P-256" } as const;

const HOUR = 60 * 60 * 1000;
/** Clock skew allowance on `notBefore`. */
const BACKDATE = HOUR;
const CA_VALIDITY = 365 * 24 * HOUR;
const LEAF_VALIDITY = 24 * HOUR;
/** Re-mint a cached leaf this long before it expires. */
const LEAF_REFRESH = HOUR;

const attempt = <A>(message: string, f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new CaError({ message, cause }) });

/** 16 random bytes, hex, high bit clear (a positive DER integer). */
const serialNumber = Effect.sync(() => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[0]! &= 0x7f;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
});

const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

const toPem = (label: string, der: ArrayBuffer) => {
  const base64 = Buffer.from(der).toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

/** Mint a fresh CA. Each call is a new, unrelated authority. */
export const makeLocalCa: Effect.Effect<LocalCa, CaError> = Effect.gen(function* () {
  yield* Effect.sync(() => x509.cryptoProvider.set(globalThis.crypto));

  const keys = yield* attempt("generate CA key", () =>
    crypto.subtle.generateKey(KEY, false, ["sign", "verify"]),
  );
  const now = yield* Clock.currentTimeMillis;
  const caSerial = yield* serialNumber;
  const subjectKeyId = yield* attempt("derive subject key id", () =>
    x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
  );
  const caCert = yield* attempt("sign CA certificate", () =>
    x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: caSerial,
      name: "CN=Alchemy Egress Sandbox CA, O=Alchemy",
      notBefore: new Date(now - BACKDATE),
      notAfter: new Date(now + CA_VALIDITY),
      signingAlgorithm: SIGNING,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        subjectKeyId,
      ],
    }),
  );
  const authorityKeyId = yield* attempt("derive authority key id", () =>
    x509.AuthorityKeyIdentifierExtension.create(keys.publicKey),
  );

  const mint = (host: string) =>
    Effect.gen(function* () {
      const leafKeys = yield* attempt(`generate key for ${host}`, () =>
        crypto.subtle.generateKey(KEY, true, ["sign", "verify"]),
      );
      const serial = yield* serialNumber;
      const issued = yield* Clock.currentTimeMillis;
      const notAfter = issued + LEAF_VALIDITY;
      const cert = yield* attempt(`sign certificate for ${host}`, () =>
        x509.X509CertificateGenerator.create({
          serialNumber: serial,
          subject: `CN=${host}`,
          issuer: caCert.subject,
          notBefore: new Date(issued - BACKDATE),
          notAfter: new Date(notAfter),
          signingAlgorithm: SIGNING,
          signingKey: keys.privateKey,
          publicKey: leafKeys.publicKey,
          extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
            new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
            new x509.SubjectAlternativeNameExtension([
              { type: isIp(host) ? "ip" : "dns", value: host },
            ]),
            authorityKeyId,
          ],
        }),
      );
      const pkcs8 = yield* attempt(`export key for ${host}`, () =>
        crypto.subtle.exportKey("pkcs8", leafKeys.privateKey),
      );
      return {
        leaf: { cert: cert.toString("pem"), key: toPem("PRIVATE KEY", pkcs8) },
        refreshAt: notAfter - LEAF_REFRESH,
      };
    });

  // One in-flight or completed mint per host. The check-and-insert runs in a
  // single `Effect.sync`, so concurrent first requests share one Deferred.
  const leaves = new Map<string, Deferred.Deferred<{ leaf: Leaf; refreshAt: number }, CaError>>();

  const leafFor = (host: string): Effect.Effect<Leaf, CaError> =>
    Effect.gen(function* () {
      const key = host.toLowerCase();
      const fresh = yield* Deferred.make<{ leaf: Leaf; refreshAt: number }, CaError>();
      const existing = yield* Effect.sync(() => {
        const current = leaves.get(key);
        if (current) return current;
        leaves.set(key, fresh);
        return undefined;
      });
      if (existing) {
        const cached = yield* Deferred.await(existing);
        const at = yield* Clock.currentTimeMillis;
        if (at < cached.refreshAt) return cached.leaf;
        // Expiring: drop it (unless someone already replaced it) and mint again.
        yield* Effect.sync(() => {
          if (leaves.get(key) === existing) leaves.delete(key);
        });
        return yield* leafFor(host);
      }
      // The mint runs detached from this caller: interrupting the first
      // requester must not leave the others waiting on a dead fiber.
      yield* mint(key).pipe(
        Effect.onExit((exit) =>
          Effect.andThen(
            // A failed mint is not cached: the next request retries.
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.sync(() => {
                  if (leaves.get(key) === fresh) leaves.delete(key);
                }),
            Deferred.done(fresh, exit),
          ),
        ),
        Effect.forkDetach,
      );
      return (yield* Deferred.await(fresh)).leaf;
    });

  return { pem: caCert.toString("pem"), leafFor } satisfies LocalCa;
});
