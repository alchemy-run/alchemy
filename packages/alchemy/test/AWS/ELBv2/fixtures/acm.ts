import * as acm from "@distilled.cloud/aws/acm";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

class CertificateImportFailed extends Data.TaggedError(
  "CertificateImportFailed",
)<{ readonly domainName: string }> {}

/**
 * Find an existing imported test certificate by domain (a previous run may
 * have left one behind) or import the checked-in self-signed fixture. Import
 * without a CertificateArn mints a new certificate each call, so reuse keeps
 * repeated runs deterministic and leak-free.
 */
export const ensureImportedCert = Effect.fn(function* (
  domainName: string,
  certPem: string,
  keyPem: string,
) {
  const pages = yield* acm.listCertificates
    .pages({ CertificateStatuses: ["ISSUED"] })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.CertificateSummaryList ?? []),
      ),
    );
  const existing = pages.find((c) => c.DomainName === domainName);
  if (existing?.CertificateArn) {
    return existing.CertificateArn;
  }
  const encode = (pem: string) =>
    Effect.sync(() => new TextEncoder().encode(pem));
  const imported = yield* acm.importCertificate({
    Certificate: yield* encode(certPem),
    PrivateKey: yield* encode(keyPem),
  });
  if (!imported.CertificateArn) {
    return yield* Effect.fail(new CertificateImportFailed({ domainName }));
  }
  return imported.CertificateArn;
});

/**
 * Deleting right after the listener detaches can race eventual consistency;
 * retry briefly, then leave the certificate behind (the next run reuses it).
 */
export const deleteCertBestEffort = Effect.fn(function* (
  certificateArn: string,
) {
  yield* acm.deleteCertificate({ CertificateArn: certificateArn }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ResourceInUseException",
      schedule: Schedule.spaced("3 seconds").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
    Effect.catchTag("ResourceInUseException", () =>
      Effect.logWarning(
        `certificate ${certificateArn} still in use; leaving it for reuse`,
      ),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});
