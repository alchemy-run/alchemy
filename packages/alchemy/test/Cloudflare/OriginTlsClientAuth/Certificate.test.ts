import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Vitest";
import * as originTls from "@distilled.cloud/cloudflare/origin-tls-client-auth";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CERT_1, CERT_2, KEY_1, KEY_2 } from "./fixtures/certs.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error (part of
// each operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getCertificate = (zoneId: string, certificateId: string) =>
  originTls.getOriginTlsClientAuth({ zoneId, certificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Cloudflare keeps deleted zone client certificates readable by id as
// `pending_deletion` / `deleted` tombstones (and excludes them from list),
// so "gone" means tombstoned or 404.
const waitForGone = (zoneId: string, certificateId: string) =>
  getCertificate(zoneId, certificateId).pipe(
    Effect.flatMap((cert) =>
      cert.status === "pending_deletion" || cert.status === "deleted"
        ? Effect.void
        : Effect.fail({ _tag: "CertificateNotDeleted" } as const),
    ),
    Effect.catchTag("CertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotDeleted",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

// Purge any live zone client certificates left behind by interrupted runs so
// each test starts from a clean slate (the zone-level cert store is only
// exercised by this suite).
const purgeCertificates = (zoneId: string) =>
  Effect.gen(function* () {
    const list = yield* originTls.listOriginTlsClientAuths({ zoneId }).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );
    yield* Effect.forEach(
      list.result.filter(
        (c) =>
          c.id && c.status !== "deleted" && c.status !== "pending_deletion",
      ),
      (c) =>
        originTls
          .deleteOriginTlsClientAuth({ zoneId, certificateId: c.id! })
          .pipe(Effect.catchTag("CertificateNotFound", () => Effect.void)),
    );
  });

test.provider(
  "uploads and deletes a zone client certificate",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeCertificates(zoneId);

      const cert = yield* stack.deploy(
        Cloudflare.OriginTlsClientAuthCertificate("AopCert", {
          zoneId,
          certificate: CERT_1,
          privateKey: Redacted.make(KEY_1),
        }),
      );

      expect(cert.certificateId).toBeDefined();
      expect(cert.zoneId).toEqual(zoneId);
      expect(cert.status).toBeDefined();
      expect(cert.expiresOn).toBeDefined();
      expect(cert.issuer).toContain("Alchemy AOP Test Cert 1");

      const actual = yield* getCertificate(zoneId, cert.certificateId);
      expect(actual.id).toEqual(cert.certificateId);
      expect(actual.status).not.toEqual("deleted");
      expect(actual.status).not.toEqual("pending_deletion");

      yield* stack.destroy();

      yield* waitForGone(zoneId, cert.certificateId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replaces the certificate when the PEM changes",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeCertificates(zoneId);

      const original = yield* stack.deploy(
        Cloudflare.OriginTlsClientAuthCertificate("ReplaceCert", {
          zoneId,
          certificate: CERT_1,
          privateKey: Redacted.make(KEY_1),
        }),
      );

      const replaced = yield* stack.deploy(
        Cloudflare.OriginTlsClientAuthCertificate("ReplaceCert", {
          zoneId,
          certificate: CERT_2,
          privateKey: Redacted.make(KEY_2),
        }),
      );

      expect(replaced.certificateId).toBeDefined();
      expect(replaced.certificateId).not.toEqual(original.certificateId);
      expect(replaced.issuer).toContain("Alchemy AOP Test Cert 2");

      // The old certificate must be gone after the replacement completes.
      yield* waitForGone(zoneId, original.certificateId);

      const actual = yield* getCertificate(zoneId, replaced.certificateId);
      expect(actual.id).toEqual(replaced.certificateId);

      yield* stack.destroy();

      yield* waitForGone(zoneId, replaced.certificateId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
