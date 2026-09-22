import * as AWS from "@/AWS";
import {
  Certificate,
  CertificateCaaError,
  validationRecordsOf,
} from "@/AWS/ACM/Certificate.ts";
import {
  dnsValidatorLayer,
  resolveDnsValidator,
  type DnsValidationRecord,
} from "@/AWS/ACM/DnsValidator.ts";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

describe(
  "AWS.ACM DNS validators (registry)",
  { tags: ["unit", "provider:aws", "provider:aws:acm", "local"] },
  () => {
    test(
      "an unregistered validator type fails with a typed, actionable error",
      Effect.gen(function* () {
        const result = yield* Effect.result(
          resolveDnsValidator({ type: "Nope.DNS" }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("DnsValidatorNotRegistered");
          expect(result.failure.message).toContain("providers()");
        }
      }),
    );

    test(
      "a registered validator receives the records",
      Effect.gen(function* () {
        const seen: DnsValidationRecord[] = [];
        const layer = dnsValidatorLayer("Fake.DNS", () =>
          Effect.succeed({
            upsert: (records) =>
              Effect.sync(() => {
                seen.push(...records);
              }),
          }),
        );
        yield* Effect.gen(function* () {
          const validator = yield* resolveDnsValidator({ type: "Fake.DNS" });
          yield* validator.upsert([
            {
              name: "_abc.example.com.",
              type: "CNAME",
              value: "_xyz.acm-validations.aws.",
            },
          ]);
        }).pipe(Effect.provide(layer));
        expect(seen).toEqual([
          {
            name: "_abc.example.com.",
            type: "CNAME",
            value: "_xyz.acm-validations.aws.",
          },
        ]);
      }),
    );

    test(
      "a wildcard and its apex publish one shared validation record",
      Effect.gen(function* () {
        const shared = {
          Name: "_abc.example.com.",
          Type: "CNAME" as const,
          Value: "_xyz.acm-validations.aws.",
        };
        const records = validationRecordsOf({
          DomainValidationOptions: [
            { DomainName: "example.com", ResourceRecord: shared },
            { DomainName: "*.example.com", ResourceRecord: shared },
            { DomainName: "www.other.com", ResourceRecord: undefined },
          ],
        });
        expect(records).toEqual([
          {
            name: "_abc.example.com.",
            type: "CNAME",
            value: "_xyz.acm-validations.aws.",
          },
        ]);
      }),
    );

    test(
      "CAA failures name the records to add",
      Effect.gen(function* () {
        const error = new CertificateCaaError({
          certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
          domainName: "example.com",
        });
        expect(error._tag).toBe("CertificateCaaError");
        expect(error.message).toContain('0 issue "amazon.com"');
        expect(error.message).toContain("issuewild");
      }),
    );
  },
);

// Live: an ACM certificate validated through the standing Cloudflare test
// zone reaches ISSUED. ACM validation takes minutes (speed doctrine), so the
// test only runs with `AWS_TEST_SLOW=1`. The validation CNAME is left in the
// zone on purpose — ACM reuses it for every certificate on the name.
const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const DOMAIN = `alchemy-acm-cf-validation.${zoneName}`;

test.provider.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "a certificate validated through Cloudflare DNS reaches ISSUED",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zone = yield* findZoneByName({ accountId, name: zoneName });
      if (!zone) {
        return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
      }

      const cert = yield* stack.deploy(
        Certificate("CloudflareValidatedCertificate", {
          domainName: DOMAIN,
          dnsValidation: Cloudflare.DNS.AcmValidator(),
        }),
      );
      expect(cert.status).toBe("ISSUED");

      // The validation CNAME landed in the Cloudflare zone, DNS-only.
      const record = cert.domainValidationOptions[0]?.ResourceRecord;
      expect(record).toBeDefined();
      const name = record!.Name.replace(/\.$/, "");
      const [cname] = yield* dns.listRecords
        .items({ zoneId: zone.id, name: { exact: name }, type: "CNAME" })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      expect(cname?.content?.replace(/\.$/, "")).toBe(
        record!.Value.replace(/\.$/, ""),
      );
      expect(cname?.proxied).toBe(false);

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:acm",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
    timeout: 600_000,
  },
);
