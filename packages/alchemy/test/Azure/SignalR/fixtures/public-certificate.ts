import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

/** Cloudflare zone the test controls; DNS-01 challenges are published there. */
export const PUBLIC_ZONE_NAME =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

/** Id of {@link PUBLIC_ZONE_NAME}. */
export const resolvePublicZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: PUBLIC_ZONE_NAME });
  if (!zone) {
    return yield* Effect.fail(new Error(`zone ${PUBLIC_ZONE_NAME} not found`));
  }
  return zone.id;
});

/**
 * A publicly trusted (Let's Encrypt production) RSA certificate for
 * `{label}.{PUBLIC_ZONE_NAME}`. Azure SignalR rejects self-signed
 * certificates (custom certificate state `Failed`), so the custom
 * certificate lifecycle needs a real one.
 */
export const publicCertificate = (zoneId: string, label: string) =>
  Effect.gen(function* () {
    const account = yield* ACME.Account("LetsEncrypt", {
      ca: ACME.LetsEncrypt,
      termsOfServiceAgreed: true,
    });
    return yield* ACME.Certificate("PublicTls", {
      account,
      identifiers: [`${label}.${PUBLIC_ZONE_NAME}`],
      solver: Cloudflare.DNS.AcmeSolver({ zoneId }),
      keyAlgorithm: "RS256",
    });
  });

/**
 * Package a PEM chain and PKCS#8 key as a password-less PFX (base64) with
 * `openssl pkcs12 -export`, using the widely supported SHA1/3DES encoding.
 */
export const toPfxBase64 = (
  chain: string,
  privateKey: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const input = new TextEncoder().encode(
      `${Redacted.value(privateKey)}\n${chain}\n`,
    );
    const process = yield* ChildProcess.make(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-passout",
        "pass:",
        "-keypbe",
        "PBE-SHA1-3DES",
        "-certpbe",
        "PBE-SHA1-3DES",
        "-macalg",
        "sha1",
      ],
      { stdin: Stream.make(input), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        process.stdout.pipe(Stream.runCollect),
        process.stderr.pipe(Stream.decodeText(), Stream.runCollect),
        process.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0) {
      return yield* Effect.fail(
        new Error(`openssl pkcs12 failed: ${[...stderr].join("")}`),
      );
    }
    return yield* Effect.sync(() =>
      Buffer.concat([...stdout]).toString("base64"),
    );
  }).pipe(Effect.scoped);
