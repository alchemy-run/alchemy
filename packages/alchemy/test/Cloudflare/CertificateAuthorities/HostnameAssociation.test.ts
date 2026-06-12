import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Vitest";
import * as certificateAuthorities from "@distilled.cloud/cloudflare/certificate-authorities";
import * as mtls from "@distilled.cloud/cloudflare/mtls-certificates";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CA_CERT_1, CA_CERT_2 } from "./fixtures/certs.ts";

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
// each operation's error union via distilled patches). Bounded:
// 6 retries of 500ms exponential backoff = max ~31.5s.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getHostnames = (zoneId: string, mtlsCertificateId?: string) =>
  certificateAuthorities
    .getHostnameAssociation({ zoneId, mtlsCertificateId })
    .pipe(
      Effect.map((r) => [...(r.hostnames ?? [])].sort()),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 6,
      }),
    );

// Normalize the keyed association to a known (empty) baseline so each run
// starts from the same cloud state regardless of what a previous (possibly
// interrupted) run left behind.
const clearAssociation = (zoneId: string, mtlsCertificateId?: string) =>
  certificateAuthorities
    .putHostnameAssociation({ zoneId, mtlsCertificateId, hostnames: [] })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 6,
      }),
    );

// PUT→GET on the association is eventually consistent at the edge — poll
// with a typed, bounded retry until the observed set matches.
const waitForHostnames = (
  zoneId: string,
  expected: ReadonlyArray<string>,
  mtlsCertificateId?: string,
) =>
  getHostnames(zoneId, mtlsCertificateId).pipe(
    Effect.flatMap((observed) =>
      observed.length === expected.length &&
      observed.every((h, i) => h === [...expected].sort()[i])
        ? Effect.succeed(observed)
        : Effect.fail({ _tag: "HostnamesNotConverged", observed } as const),
    ),
    Effect.retry({
      while: (e) => e._tag === "HostnamesNotConverged",
      // Bounded: 15 polls x 3s = max ~45s of waiting (the clear after a
      // destroy was once observed to take just over 30s to converge).
      schedule: Schedule.spaced("3 seconds").pipe(
        Schedule.both(Schedule.recurs(15)),
      ),
    }),
  );

const waitForCertDelete = (accountId: string, mtlsCertificateId: string) =>
  mtls.getMtlsCertificate({ accountId, mtlsCertificateId }).pipe(
    Effect.flatMap((cert) =>
      cert.id === mtlsCertificateId
        ? Effect.fail({ _tag: "CertificateNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.catchTag("CertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotDeleted",
      // Bounded: 10 polls x 3s = max ~30s of waiting.
      schedule: Schedule.spaced("3 seconds").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

test.provider(
  "pins Managed CA hostnames, updates in place, and clears on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      // Known baseline: no Managed CA hostname associations.
      yield* clearAssociation(zoneId);

      const created = yield* stack.deploy(
        Cloudflare.HostnameAssociation("ManagedCaHosts", {
          zoneId,
          hostnames: [`mtls.${zoneName}`],
        }),
      );

      expect(created.zoneId).toEqual(zoneId);
      expect(created.mtlsCertificateId).toBeUndefined();
      expect(created.hostnames).toEqual([`mtls.${zoneName}`]);

      yield* waitForHostnames(zoneId, [`mtls.${zoneName}`]);

      // In-place update — hostnames are the mutable aspect of the singleton.
      const updated = yield* stack.deploy(
        Cloudflare.HostnameAssociation("ManagedCaHosts", {
          zoneId,
          hostnames: [`mtls2.${zoneName}`, `mtls.${zoneName}`],
        }),
      );

      expect([...updated.hostnames].sort()).toEqual([
        `mtls.${zoneName}`,
        `mtls2.${zoneName}`,
      ]);

      yield* waitForHostnames(zoneId, [
        `mtls.${zoneName}`,
        `mtls2.${zoneName}`,
      ]);

      yield* stack.destroy();

      // Destroy cleared the association (PUT of an empty hostname list).
      yield* waitForHostnames(zoneId, []);
    }).pipe(logLevel),
);

test.provider(
  "associates hostnames with an uploaded CA and destroys before the cert",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const { cert, assoc } = yield* stack.deploy(
        Effect.gen(function* () {
          const cert = yield* Cloudflare.MtlsCertificate("CertAuthCa", {
            ca: true,
            certificates: CA_CERT_1,
          });
          const assoc = yield* Cloudflare.HostnameAssociation("CaHosts", {
            zoneId,
            mtlsCertificateId: cert.mtlsCertificateId,
            hostnames: [`mtls-ca.${zoneName}`],
          });
          return { cert, assoc };
        }),
      );

      expect(cert.mtlsCertificateId).toBeDefined();
      expect(assoc.mtlsCertificateId).toEqual(cert.mtlsCertificateId);
      expect(assoc.hostnames).toEqual([`mtls-ca.${zoneName}`]);

      yield* waitForHostnames(
        zoneId,
        [`mtls-ca.${zoneName}`],
        cert.mtlsCertificateId,
      );

      // Destroy must clear the association before deleting the certificate —
      // Cloudflare refuses to delete a CA that hostnames still reference.
      yield* stack.destroy();

      yield* waitForCertDelete(accountId, cert.mtlsCertificateId);
    }).pipe(logLevel),
);

test.provider(
  "changing the certificate key replaces the association",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* clearAssociation(zoneId);

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const assoc = yield* Cloudflare.HostnameAssociation("ReplaceHosts", {
            zoneId,
            hostnames: [`mtls-replace.${zoneName}`],
          });
          return { assoc };
        }),
      );

      expect(first.assoc.mtlsCertificateId).toBeUndefined();
      yield* waitForHostnames(zoneId, [`mtls-replace.${zoneName}`]);

      // mtlsCertificateId keys the association — switching from the Managed
      // CA to an uploaded CA is a replacement: the new keyed association is
      // created and the old Managed CA list is cleared as the old instance
      // deletes.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const cert = yield* Cloudflare.MtlsCertificate("ReplaceCa", {
            ca: true,
            certificates: CA_CERT_2,
          });
          const assoc = yield* Cloudflare.HostnameAssociation("ReplaceHosts", {
            zoneId,
            mtlsCertificateId: cert.mtlsCertificateId,
            hostnames: [`mtls-replace.${zoneName}`],
          });
          return { cert, assoc };
        }),
      );

      expect(second.assoc.mtlsCertificateId).toEqual(
        second.cert.mtlsCertificateId,
      );

      yield* waitForHostnames(
        zoneId,
        [`mtls-replace.${zoneName}`],
        second.cert.mtlsCertificateId,
      );
      // The old Managed CA association was cleared by the replacement.
      yield* waitForHostnames(zoneId, []);

      yield* stack.destroy();

      yield* waitForCertDelete(accountId, second.cert.mtlsCertificateId);
    }).pipe(logLevel),
);
