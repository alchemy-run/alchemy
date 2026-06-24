import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as originCa from "@distilled.cloud/cloudflare/origin-ca-certificates";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

import { TEST_CSR } from "./fixtures/csr.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName = "alchemy-test-2.us";
// Each test owns a DISTINCT hostname. Adoption keys purely off the hostname
// set (the engine probes `read` with `olds: news` even on a fresh deploy, so
// `findByHostnames` runs every time), and Origin CA certs carry no other
// identity. A shared hostname therefore couples the tests: a leftover cert
// from another test or a prior crashed run can be adopted, and a sibling's
// destroy can revoke a cert this test is mid-verifying. Per-test hostnames
// make each test fully self-contained.

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getCertificate = (certificateId: string) =>
  originCa.getOriginCaCertificate({ certificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// After destroy, the certificate is revoked. GET keeps returning a revoked
// certificate (with `revokedAt` set) for a while, and may eventually flip to
// `CertificateNotFound` — either state counts as gone.
const expectRevoked = (certificateId: string) =>
  getCertificate(certificateId).pipe(
    Effect.flatMap((cert) =>
      cert.revokedAt
        ? Effect.void
        : Effect.fail({ _tag: "CertificateNotRevoked" } as const),
    ),
    Effect.catchTag("CertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotRevoked",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

test.provider("issue, verify, and revoke a certificate", (stack) =>
  Effect.gen(function* () {
    const hostname = `originissue.${zoneName}`;
    yield* stack.destroy();

    const cert = yield* stack.deploy(
      Cloudflare.OriginCaCertificate("Cert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );

    // Issuance is synchronous — the signed PEM comes back on create.
    expect(cert.certificateId).toBeTruthy();
    expect(cert.certificate).toContain("-----BEGIN CERTIFICATE-----");
    expect(cert.csr).toContain("-----BEGIN CERTIFICATE REQUEST-----");
    expect(cert.hostnames).toEqual([hostname]);
    expect(cert.requestType).toEqual("origin-rsa");
    expect(cert.requestedValidity).toEqual(90);
    expect(cert.expiresOn).toBeTruthy();

    // Out-of-band verification: the certificate is live and not revoked.
    const live = yield* getCertificate(cert.certificateId);
    expect(live.id).toEqual(cert.certificateId);
    expect(live.hostnames).toEqual([hostname]);
    expect(live.revokedAt ?? null).toBeNull();

    // Redeploying identical props is a no-op (same certificate).
    const noop = yield* stack.deploy(
      Cloudflare.OriginCaCertificate("Cert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );
    expect(noop.certificateId).toEqual(cert.certificateId);

    // Destroy revokes the certificate; a second destroy is idempotent.
    yield* stack.destroy();
    yield* expectRevoked(cert.certificateId);
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("list enumerates issued certificates", (stack) =>
  Effect.gen(function* () {
    const hostname = `originlist.${zoneName}`;
    yield* stack.destroy();

    const cert = yield* stack.deploy(
      Cloudflare.OriginCaCertificate("ListCert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.OriginCaCertificate,
    );
    const all = yield* provider.list();

    // `list()` is account-wide but enumerated per zone with the `zone_id`
    // query param; a zone the scoped token can't read for Origin CA rejects
    // with the typed `Forbidden` tag, which is swallowed so that zone simply
    // contributes []. The standing token can list the test zone, so the
    // freshly issued certificate must appear in the exhaustively-paginated
    // result in the `read` Attributes shape.
    expect(Array.isArray(all)).toBe(true);
    const match = all.find((c) => c.certificateId === cert.certificateId);
    expect(match).toBeDefined();
    expect(match!.certificateId).toEqual(cert.certificateId);
    expect(match!.hostnames).toEqual([hostname]);
    expect(match!.requestType).toEqual("origin-rsa");

    yield* stack.destroy();
    yield* expectRevoked(cert.certificateId);
  }).pipe(logLevel),
);

test.provider("replacement on requestedValidity change", (stack) =>
  Effect.gen(function* () {
    const hostname = `originvalidity.${zoneName}`;
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.OriginCaCertificate("ValidityCert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );
    expect(initial.requestedValidity).toEqual(90);

    // There is no update API — changing the validity issues a new
    // certificate and revokes the old one.
    const replaced = yield* stack.deploy(
      Cloudflare.OriginCaCertificate("ValidityCert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 30,
      }).pipe(adopt(true)),
    );

    expect(replaced.certificateId).not.toEqual(initial.certificateId);
    expect(replaced.requestedValidity).toEqual(30);
    yield* expectRevoked(initial.certificateId);

    const live = yield* getCertificate(replaced.certificateId);
    expect(live.revokedAt ?? null).toBeNull();

    yield* stack.destroy();
    yield* expectRevoked(replaced.certificateId);
  }).pipe(logLevel),
);

test.provider("replacement on hostnames change", (stack) =>
  Effect.gen(function* () {
    const hostname = `originhostsa.${zoneName}`;
    const altHostname = `originhostsb.${zoneName}`;
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.OriginCaCertificate("HostnamesCert", {
        csr: TEST_CSR,
        hostnames: [hostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );
    expect(initial.hostnames).toEqual([hostname]);

    // Hostnames are immutable — changing the set issues a new certificate
    // and revokes the old one.
    const replaced = yield* stack.deploy(
      Cloudflare.OriginCaCertificate("HostnamesCert", {
        csr: TEST_CSR,
        hostnames: [hostname, altHostname],
        requestType: "origin-rsa",
        requestedValidity: 90,
      }).pipe(adopt(true)),
    );

    expect(replaced.certificateId).not.toEqual(initial.certificateId);
    expect([...replaced.hostnames].sort()).toEqual(
      [hostname, altHostname].sort(),
    );
    yield* expectRevoked(initial.certificateId);

    yield* stack.destroy();
    yield* expectRevoked(replaced.certificateId);
  }).pipe(logLevel),
);
