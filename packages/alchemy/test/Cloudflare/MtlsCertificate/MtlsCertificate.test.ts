import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as mtls from "@distilled.cloud/cloudflare/mtls-certificates";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CA_CERT_1, CA_CERT_2, LEAF_CERT, LEAF_KEY } from "./fixtures/certs.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete a CA certificate", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const cert = yield* stack.deploy(
      Cloudflare.MtlsCertificate("CaCert", {
        ca: true,
        certificates: CA_CERT_1,
      }),
    );

    expect(cert.mtlsCertificateId).toBeDefined();
    expect(cert.ca).toEqual(true);
    expect(cert.name).toBeDefined();
    expect(cert.expiresOn).toBeDefined();

    const actual = yield* mtls.getMtlsCertificate({
      accountId,
      mtlsCertificateId: cert.mtlsCertificateId,
    });
    expect(actual.id).toEqual(cert.mtlsCertificateId);
    expect(actual.ca).toEqual(true);
    expect(actual.name).toEqual(cert.name);

    yield* stack.destroy();

    yield* waitForDelete(accountId, cert.mtlsCertificateId);
  }).pipe(logLevel),
);

test.provider(
  "create and delete a leaf certificate with private key",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const cert = yield* stack.deploy(
        Cloudflare.MtlsCertificate("LeafCert", {
          ca: false,
          certificates: LEAF_CERT,
          privateKey: Redacted.make(LEAF_KEY),
        }),
      );

      expect(cert.mtlsCertificateId).toBeDefined();
      expect(cert.ca).toEqual(false);

      const actual = yield* mtls.getMtlsCertificate({
        accountId,
        mtlsCertificateId: cert.mtlsCertificateId,
      });
      expect(actual.id).toEqual(cert.mtlsCertificateId);
      expect(actual.ca).toEqual(false);

      yield* stack.destroy();

      yield* waitForDelete(accountId, cert.mtlsCertificateId);
    }).pipe(logLevel),
);

test.provider("replaces the certificate when the PEM changes", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const original = yield* stack.deploy(
      Cloudflare.MtlsCertificate("ReplaceCert", {
        ca: true,
        certificates: CA_CERT_1,
      }),
    );

    const replaced = yield* stack.deploy(
      Cloudflare.MtlsCertificate("ReplaceCert", {
        ca: true,
        certificates: CA_CERT_2,
      }),
    );

    expect(replaced.mtlsCertificateId).toBeDefined();
    expect(replaced.mtlsCertificateId).not.toEqual(original.mtlsCertificateId);
    expect(replaced.serialNumber).not.toEqual(original.serialNumber);

    // The old certificate must be gone after the replacement completes.
    yield* waitForDelete(accountId, original.mtlsCertificateId);

    const actual = yield* mtls.getMtlsCertificate({
      accountId,
      mtlsCertificateId: replaced.mtlsCertificateId,
    });
    expect(actual.id).toEqual(replaced.mtlsCertificateId);

    yield* stack.destroy();

    yield* waitForDelete(accountId, replaced.mtlsCertificateId);
  }).pipe(logLevel),
);

const waitForDelete = (accountId: string, mtlsCertificateId: string) =>
  mtls.getMtlsCertificate({ accountId, mtlsCertificateId }).pipe(
    Effect.flatMap((cert) =>
      cert.id === mtlsCertificateId
        ? Effect.fail({ _tag: "CertificateNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.catchTag("CertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotDeleted",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );
