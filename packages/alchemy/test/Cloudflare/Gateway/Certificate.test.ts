import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Ride out 403 blips (`Forbidden`) while the harness-minted token
// propagates across Cloudflare's edge.
const getCertificate = (accountId: string, certificateId: string) =>
  zeroTrust.getGatewayCertificate({ accountId, certificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A deleted certificate surfaces as `GatewayCertificateNotFound`
// (Cloudflare code 2027, "Certificate not found in SSL store").
const expectGone = (accountId: string, certificateId: string) =>
  getCertificate(accountId, certificateId).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "CertificateNotDeleted" } as const),
    ),
    Effect.catchTag("GatewayCertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotDeleted",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

test.provider(
  "create an activated certificate, deactivate in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const cert = yield* stack.deploy(
        Cloudflare.GatewayCertificate("InspectionCa", {
          validityPeriodDays: 30,
        }),
      );

      expect(cert.certificateId).toBeTruthy();
      expect(cert.accountId).toEqual(accountId);
      expect(cert.certificateType).toEqual("gateway_managed");
      expect(cert.certificate).toContain("BEGIN CERTIFICATE");
      expect(cert.fingerprint).toBeTruthy();
      // Activation settles within seconds; the provider waits for it.
      expect(cert.bindingStatus).toEqual("available");

      const live = yield* getCertificate(accountId, cert.certificateId);
      expect(live.bindingStatus).toEqual("available");
      expect(live.fingerprint).toEqual(cert.fingerprint);

      // Deactivate in place — same certificate, new binding status.
      const deactivated = yield* stack.deploy(
        Cloudflare.GatewayCertificate("InspectionCa", {
          validityPeriodDays: 30,
          activate: false,
        }),
      );
      expect(deactivated.certificateId).toEqual(cert.certificateId);
      expect(deactivated.bindingStatus).toEqual("inactive");

      yield* stack.destroy();
      yield* expectGone(accountId, cert.certificateId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "changing the validity period replaces the certificate",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Keep both generations inactive so the test stays fast — no edge
      // activation round-trips.
      const first = yield* stack.deploy(
        Cloudflare.GatewayCertificate("ShortCa", {
          validityPeriodDays: 30,
          activate: false,
        }),
      );
      expect(first.bindingStatus).toEqual("inactive");

      const second = yield* stack.deploy(
        Cloudflare.GatewayCertificate("ShortCa", {
          validityPeriodDays: 60,
          activate: false,
        }),
      );
      // The validity period is immutable — a new certificate is minted
      // and the old one deleted.
      expect(second.certificateId).not.toEqual(first.certificateId);
      yield* expectGone(accountId, first.certificateId);

      yield* stack.destroy();
      yield* expectGone(accountId, second.certificateId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
