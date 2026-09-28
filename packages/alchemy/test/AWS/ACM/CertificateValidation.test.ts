/**
 * External ACM validation: `Certificate({ dnsValidation: "external" })` →
 * the DNS adapter's validation records → `AWS.ACM.CertificateValidation`.
 *
 * The ungated tests are plan-level (registration only — no cloud calls) plus
 * a unit test of `validationRecordsOf`. The live test issues a real
 * certificate validated through the standing Cloudflare test zone and is
 * gated behind AWS_TEST_SLOW=1 (ACM issuance takes minutes).
 */
import * as AWS from "@/AWS";
import { validationRecordsOf } from "@/AWS/ACM/Certificate.ts";
import { domainCertificate } from "@/AWS/CustomDomain.ts";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Hetzner from "@/Hetzner";
import * as Output from "@/Output";
import type { ResourceLike } from "@/Resource";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState, InMemoryService, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/aws/acm";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { describe, expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

type Resources = Record<string, ResourceLike>;

const compile = (build: Effect.Effect<unknown, any, any>) =>
  Effect.scoped(
    (build as Effect.Effect<unknown>).pipe(
      Stack.make({
        name: "acm-external-validation",
        providers: Layer.mergeAll(
          Cloudflare.DNS.AdapterLive,
          Hetzner.DNS.AdapterLive,
        ),
        state: inMemoryState(),
      } as any) as any,
      Effect.map((compiled: any) => ({
        resources: compiled.resources as Resources,
        output: compiled.output as unknown,
      })),
    ),
  ).pipe(Effect.provideService(Stage, "test")) as Effect.Effect<{
    resources: Resources;
    output: unknown;
  }>;

/**
 * Resolve Output references against `upstream` attributes; any other
 * resource attribute `a` of `fqn` reads `<fqn.a>`.
 */
const resolve = (
  resources: Resources,
  value: unknown,
  upstream: Record<string, unknown> = {},
) =>
  Output.evaluate(value, {
    ...Object.fromEntries(
      Object.keys(resources).map((fqn) => [
        fqn,
        new Proxy(
          {},
          {
            get: (_, attr) =>
              typeof attr === "string" ? `<${fqn}.${attr}>` : undefined,
          },
        ),
      ]),
    ),
    ...upstream,
  }).pipe(
    Effect.provideService(State, InMemoryService()),
  ) as Effect.Effect<any>;

const typesOf = (resources: Resources) =>
  Object.fromEntries(
    Object.entries(resources).map(([fqn, resource]) => [fqn, resource.Type]),
  );

/** ACM's `DomainValidationOptions` for `example.com` + `*.example.com`. */
const domainValidationOptions: acm.DomainValidation[] = [
  {
    DomainName: "example.com",
    ValidationMethod: "DNS",
    ResourceRecord: {
      Name: "_abc.example.com.",
      Type: "CNAME",
      Value: "_xyz.acm-validations.aws.",
    },
  },
  {
    DomainName: "*.example.com",
    ValidationMethod: "DNS",
    ResourceRecord: {
      Name: "_ABC.example.com.",
      Type: "CNAME",
      Value: "_xyz.acm-validations.aws.",
    },
  },
  {
    DomainName: "www.example.org",
    ValidationMethod: "DNS",
    ResourceRecord: {
      Name: "_def.www.example.org.",
      Type: "CNAME",
      Value: "_uvw.acm-validations.aws.",
    },
  },
  // ACM has not computed this one's record yet.
  { DomainName: "pending.example.org", ValidationMethod: "DNS" },
];

describe(
  "ACM external validation (plan)",
  { tags: ["unit", "provider:aws", "provider:aws:acm", "local"] },
  () => {
    test(
      "validationRecordsOf dedupes a wildcard and its apex and skips pending records",
      Effect.sync(() => {
        // Names compare case-insensitively; the record keeps its first
        // position (the later duplicate's spelling).
        expect(validationRecordsOf(domainValidationOptions)).toEqual([
          {
            name: "_ABC.example.com.",
            type: "CNAME",
            value: "_xyz.acm-validations.aws.",
          },
          {
            name: "_def.www.example.org.",
            type: "CNAME",
            value: "_uvw.acm-validations.aws.",
          },
        ]);
        expect(validationRecordsOf(undefined)).toEqual([]);
        expect(validationRecordsOf([])).toEqual([]);
      }),
    );

    test(
      "domainCertificate with a Cloudflare adapter declares Certificate(external) + RecordList + CertificateValidation",
      Effect.gen(function* () {
        const { resources, output } = yield* compile(
          domainCertificate(
            "Certificate",
            {
              domainName: "example.com",
              subjectAlternativeNames: ["*.example.com"],
              // Route 53-only: dropped for another DNS host.
              hostedZoneId: "Z1234567890ABC",
              tags: { team: "web" },
            },
            Cloudflare.DNS.Adapter({ zone: "example.com" }),
          ).pipe(Effect.map(({ certificateArn }) => ({ certificateArn }))),
        );
        expect(typesOf(resources)).toEqual({
          Certificate: "AWS.ACM.Certificate",
          CertificateValidation: "Cloudflare.DNS.RecordList",
          CertificateIssued: "AWS.ACM.CertificateValidation",
        });

        const certificate = yield* resolve(
          resources,
          resources["Certificate"]!.Props,
        );
        expect(certificate).toEqual({
          domainName: "example.com",
          subjectAlternativeNames: ["*.example.com"],
          tags: { team: "web" },
          dnsValidation: "external",
        });
        expect("hostedZoneId" in certificate).toBe(false);

        // The validation records are computed from the certificate's
        // `domainValidationOptions` and retained on destroy.
        expect(
          yield* resolve(resources, resources["CertificateValidation"]!.Props, {
            Certificate: { domainValidationOptions },
          }),
        ).toEqual({
          zone: "example.com",
          records: validationRecordsOf(domainValidationOptions),
        });
        expect(resources["CertificateValidation"]!.RemovalPolicy).toBe(
          "retain",
        );

        expect(
          yield* resolve(resources, resources["CertificateIssued"]!.Props),
        ).toEqual({ certificateArn: "<Certificate.certificateArn>" });
        // Consumers get the ARN only once the certificate is issued.
        expect(yield* resolve(resources, output)).toEqual({
          certificateArn: "<CertificateIssued.certificateArn>",
        });
      }),
    );

    test(
      "domainCertificate with a Hetzner adapter publishes through Hetzner.DNS.RecordList",
      Effect.gen(function* () {
        const { resources } = yield* compile(
          domainCertificate(
            "Certificate",
            { domainName: "example.com" },
            Hetzner.DNS.Adapter(),
          ),
        );
        expect(typesOf(resources)).toEqual({
          Certificate: "AWS.ACM.Certificate",
          CertificateValidation: "Hetzner.DNS.RecordList",
          CertificateIssued: "AWS.ACM.CertificateValidation",
        });
      }),
    );

    test(
      "domainCertificate on Route 53 (default, explicit, or dns: false) is one inline-validated Certificate",
      Effect.gen(function* () {
        for (const dnsConfig of [
          undefined,
          AWS.Route53.Adapter({ hostedZoneId: "Z1" }),
          false as const,
        ]) {
          const { resources, output } = yield* compile(
            domainCertificate(
              "Certificate",
              { domainName: "example.com", hostedZoneId: "Z1" },
              dnsConfig,
            ).pipe(Effect.map(({ certificateArn }) => ({ certificateArn }))),
          );
          expect(typesOf(resources)).toEqual({
            Certificate: "AWS.ACM.Certificate",
          });
          expect(resources["Certificate"]!.Props).toEqual({
            domainName: "example.com",
            hostedZoneId: "Z1",
          });
          expect(yield* resolve(resources, output)).toEqual({
            certificateArn: "<Certificate.certificateArn>",
          });
        }
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Live — gated on AWS_TEST_SLOW=1: ACM issuance through public DNS takes
// minutes.
// ---------------------------------------------------------------------------

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const DOMAIN = `alchemy-acm-validation.${zoneName}`;

// Certificates for CloudFront are pinned to us-east-1.
const withUsEast1 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

const listCnames = (zoneId: string, name: string) =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type: "CNAME" }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const normalize = (name: string) => name.replace(/\.$/, "").toLowerCase();

describe.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "ACM external validation (live)",
  {
    tags: [
      "provider:aws",
      "provider:aws:acm",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
  },
  () => {
    test.provider(
      "a certificate validated through Cloudflare DNS reaches ISSUED",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { accountId } = yield* yield* CloudflareEnvironment;
          const zone = yield* findZoneByName({ accountId, name: zoneName });
          if (!zone) {
            return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
          }

          const [elapsed, deployed] = yield* stack
            .deploy(
              domainCertificate(
                "Cert",
                {
                  domainName: DOMAIN,
                  // Shares the apex's validation CNAME (deduped to one record).
                  subjectAlternativeNames: [`*.${DOMAIN}`],
                },
                Cloudflare.DNS.Adapter({ zone: zoneName }),
              ).pipe(
                Effect.map(({ certificate, certificateArn }) => ({
                  certificateArn,
                  domainValidationOptions: certificate.domainValidationOptions,
                })),
              ),
            )
            .pipe(Effect.timed);
          yield* Effect.logInfo(
            `ACM external validation: deployed + issued in ${Duration.format(elapsed)}`,
          );

          const described = yield* withUsEast1(
            acm.describeCertificate({
              CertificateArn: deployed.certificateArn,
            }),
          );
          expect(described.Certificate?.Status).toBe("ISSUED");

          // One CNAME for the apex + wildcard, published DNS-only.
          const [record, ...others] = validationRecordsOf(
            deployed.domainValidationOptions,
          );
          expect(others).toHaveLength(0);
          const [cname] = yield* listCnames(zone.id, normalize(record!.name));
          expect(normalize(cname?.content ?? "")).toBe(
            normalize(record!.value),
          );
          expect(cname?.proxied).toBe(false);

          yield* stack.destroy();

          // The certificate is deleted …
          const status = yield* withUsEast1(
            acm
              .describeCertificate({ CertificateArn: deployed.certificateArn })
              .pipe(
                Effect.map(() => "present" as const),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed("gone" as const),
                ),
                Effect.repeat({
                  schedule: Schedule.spaced("2 seconds"),
                  until: (s) => s === "gone",
                  times: 10,
                }),
              ),
          );
          expect(status).toBe("gone");

          // … while the validation CNAME is retained (ACM reuses it for any
          // certificate covering the name). Remove this test's copy.
          const retained = yield* listCnames(zone.id, normalize(record!.name));
          expect(retained).toHaveLength(1);
          yield* Effect.forEach(
            retained,
            (r) => dns.deleteRecord({ zoneId: zone.id, dnsRecordId: r.id }),
            { discard: true },
          );
        }),
      { timeout: 900_000 },
    );
  },
);
