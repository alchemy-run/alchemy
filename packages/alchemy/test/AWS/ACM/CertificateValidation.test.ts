import * as AWS from "@/AWS";
import { Certificate } from "@/AWS/ACM/Certificate.ts";
import { CertificateValidation } from "@/AWS/ACM/CertificateValidation.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

// The certificate is requested in ACM's default region (us-east-1); every
// out-of-band ACM call must target the same region.
const withUsEast1 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

/**
 * Deterministic per-runner hostname on the standing Cloudflare test zone —
 * stable across runs of the same PR/user, distinct across runners, so
 * parallel CI runs never fight over one validation record.
 */
const runner = (process.env.PULL_REQUEST ?? process.env.USER ?? "local")
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-");
const ZONE_NAME =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const DOMAIN = `acm-validation-${runner}.${ZONE_NAME}`;

const trimDot = (value: string) => value.replace(/\.$/, "");

const describeCertificate = (certificateArn: string) =>
  withUsEast1(
    acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
      Effect.map((response) => response.Certificate),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    ),
  );

const countRecords = (zoneId: string, name: string) =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type: "CNAME" }).pipe(
    Stream.filter((record) => record.name === name),
    Stream.runCount,
  );

// The full cross-provider validation path: ACM requests the certificate
// (no Route 53 zone governs the test domain, so `Certificate` returns
// PENDING with its validation record), the record is published on
// Cloudflare through the canonical `Cloudflare.DNS.Record` (zone inferred
// from the name), and `CertificateValidation` — ordered after the record —
// waits for issuance. Budget: ACM populates the validation record within
// seconds, Cloudflare serves the CNAME immediately, and ACM issues within
// ~1-3 minutes of the record resolving; the validation's own budget is 5
// minutes, so the test allows that plus request + teardown.
test.provider.skipIf(!!process.env.FAST)(
  "waits for a certificate validated through a Cloudflare DNS record",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const certificate = yield* Certificate("Certificate", {
            domainName: DOMAIN,
          });
          const validationRecord = certificate.domainValidationOptions.pipe(
            Output.map(
              (validations: acm.DomainValidation[]) =>
                validations[0]?.ResourceRecord,
            ),
          );
          const record = yield* Cloudflare.DNS.Record("ValidationRecord", {
            name: validationRecord.pipe(
              Output.map((record: acm.ResourceRecord | undefined) =>
                trimDot(record?.Name ?? ""),
              ),
            ),
            type: "CNAME",
            content: validationRecord.pipe(
              Output.map((record: acm.ResourceRecord | undefined) =>
                trimDot(record?.Value ?? ""),
              ),
            ),
            proxied: false,
          });
          const validation = yield* CertificateValidation("Validation", {
            certificateArn: certificate.certificateArn,
            validationRecordFqdns: [record.name],
          });
          return {
            certificateArn: certificate.certificateArn,
            validation,
            recordName: record.name,
            zoneId: record.zoneId,
          };
        }),
      );

      expect(deployed.validation.certificateArn).toBe(deployed.certificateArn);
      expect(deployed.validation.status).toBe("ISSUED");
      expect(deployed.validation.validationRecordFqdns).toEqual([
        deployed.recordName,
      ]);
      expect(deployed.recordName.endsWith(`.${DOMAIN}`)).toBe(true);

      // Out-of-band: ACM reports the certificate ISSUED, and the validation
      // record landed on Cloudflare.
      const issued = yield* describeCertificate(deployed.certificateArn);
      expect(issued?.Status).toBe("ISSUED");
      expect(issued?.DomainName).toBe(DOMAIN);
      expect(yield* countRecords(deployed.zoneId, deployed.recordName)).toBe(1);

      yield* stack.destroy();

      // Out-of-band gone-proofs: certificate deleted (validation owns
      // nothing, so its no-op delete must not block the certificate's), and
      // the Cloudflare record removed.
      expect(yield* describeCertificate(deployed.certificateArn)).toBe(
        undefined,
      );
      expect(yield* countRecords(deployed.zoneId, deployed.recordName)).toBe(0);
    }),
  { timeout: 480_000 },
);
