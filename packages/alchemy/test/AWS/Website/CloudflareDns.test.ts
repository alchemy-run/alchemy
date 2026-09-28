/**
 * `Cloudflare.DNS.Adapter()` on AWS website composites: a domain whose DNS
 * lives in Cloudflare (e.g. a Cloudflare Registrar domain) pointed at a
 * CloudFront distribution.
 *
 * The ungated tests compile real compositions (registration only — no cloud
 * calls) and assert on the resources and binding rows the engine collects:
 * the certificate is validated externally (`dnsValidation: "external"` +
 * a `Cloudflare.DNS.RecordList` of validation CNAMEs +
 * `AWS.ACM.CertificateValidation`), and each hostname gets a
 * `Cloudflare.DNS.Records` CNAME (`AliasRecord{n}-CNAME`).
 *
 * The live suite is gated behind AWS_TEST_SLOW=1 (CloudFront deploys take
 * minutes — speed doctrine) and uses the standing Cloudflare test zone.
 */
import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Hetzner from "@/Hetzner";
import * as Output from "@/Output";
import type { ResourceBinding, ResourceLike } from "@/Resource";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState, InMemoryService, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { resolve4, resolveNs, Resolver } from "node:dns/promises";
import { fileURLToPath } from "node:url";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

// Anchor the fixture to the repo root regardless of the runner's cwd.
const fixtureDir = fileURLToPath(
  new URL("../../../../../examples/aws-static-site/site", import.meta.url),
);

interface Compiled {
  resources: Record<string, ResourceLike>;
  bindings: Record<string, ResourceBinding[]>;
}

/**
 * Compile a composition (registration only — no plan, no apply, no cloud
 * calls) with the DNS adapters registered, and return the resources and
 * binding rows the engine collected, keyed by FQN.
 */
const compileStack = (
  build: Effect.Effect<unknown, any, any>,
): Effect.Effect<Compiled> =>
  Effect.scoped(
    (build as Effect.Effect<unknown>).pipe(
      Stack.make({
        name: "cloudflare-dns-website",
        providers: Layer.mergeAll(
          Cloudflare.DNS.AdapterLive,
          Hetzner.DNS.AdapterLive,
        ),
        state: inMemoryState(),
      } as any) as any,
      Effect.map((compiled: any) => ({
        resources: compiled.resources as Record<string, ResourceLike>,
        bindings: compiled.bindings as Record<string, ResourceBinding[]>,
      })),
    ),
  ).pipe(Effect.provideService(Stage, "test")) as Effect.Effect<Compiled>;

/** Resolve Output references: attribute `a` of resource `fqn` reads `<fqn.a>`. */
const resolve = (compiled: Compiled, value: unknown) =>
  Output.evaluate(
    value,
    Object.fromEntries(
      Object.keys(compiled.resources).map((fqn) => [
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
  ).pipe(Effect.provideService(State, InMemoryService())) as Effect.Effect<any>;

const typesOf = (compiled: Compiled) =>
  Object.fromEntries(
    Object.entries(compiled.resources).map(([fqn, resource]) => [
      fqn,
      resource.Type,
    ]),
  );

const propsOf = (compiled: Compiled, fqn: string) => {
  expect(compiled.resources[fqn]).toBeDefined();
  return resolve(compiled, compiled.resources[fqn]!.Props);
};

describe(
  "AWS.Website Cloudflare DNS (composition)",
  {
    tags: [
      "unit",
      "provider:aws",
      "provider:aws:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "local",
    ],
  },
  () => {
    test(
      "a StaticSite on Cloudflare DNS validates through Cloudflare and CNAMEs every hostname",
      Effect.gen(function* () {
        const compiled = yield* compileStack(
          AWS.Website.StaticSite("Web", {
            path: fixtureDir,
            domain: {
              name: "www.example.com",
              aliases: ["example.com"],
              redirects: ["old.example.com"],
              // Ignored when `dns` names another host.
              hostedZoneId: "Z1234567890ABC",
              dns: Cloudflare.DNS.Adapter({ zone: "example.com" }),
            },
          }),
        );
        const types = typesOf(compiled);

        expect(types["Web/Certificate"]).toBe("AWS.ACM.Certificate");
        const certificate = yield* propsOf(compiled, "Web/Certificate");
        expect(certificate).toEqual({
          domainName: "www.example.com",
          subjectAlternativeNames: ["example.com", "old.example.com"],
          dnsValidation: "external",
          tags: undefined,
        });
        expect("hostedZoneId" in certificate).toBe(false);

        // Validation CNAMEs, retained on destroy (ACM reuses one CNAME per
        // name across certificates).
        expect(types["Web/CertificateValidation"]).toBe(
          "Cloudflare.DNS.RecordList",
        );
        expect(
          compiled.resources["Web/CertificateValidation"]!.RemovalPolicy,
        ).toBe("retain");
        expect(
          compiled.resources["Web/CertificateValidation"]!.Props.zone,
        ).toBe("example.com");

        // The distribution waits for issuance.
        expect(types["Web/CertificateIssued"]).toBe(
          "AWS.ACM.CertificateValidation",
        );
        expect(yield* propsOf(compiled, "Web/CertificateIssued")).toEqual({
          certificateArn: "<Web/Certificate.certificateArn>",
        });
        expect(
          (yield* propsOf(compiled, "Web/Distribution")).viewerCertificate
            .acmCertificateArn,
        ).toBe("<Web/CertificateIssued.certificateArn>");

        for (const [index, name] of [
          "www.example.com",
          "example.com",
          "old.example.com",
        ].entries()) {
          const fqn = `Web/AliasRecord${index + 1}-CNAME`;
          expect(types[fqn]).toBe("Cloudflare.DNS.Records");
          expect(yield* propsOf(compiled, fqn)).toEqual({
            zone: "example.com",
            type: "CNAME",
            content: "<Web/Distribution.domainName>",
            names: [name],
          });
        }
        expect(Object.values(types)).not.toContain("AWS.Route53.Record");
      }),
    );

    test(
      "a zone resource reference flows into the validation and alias records",
      Effect.gen(function* () {
        const compiled = yield* compileStack(
          Effect.gen(function* () {
            const zone = yield* Cloudflare.Zone.Zone("Zone", {
              name: "example.com",
            });
            return yield* AWS.Website.StaticSite("Web", {
              path: fixtureDir,
              domain: {
                name: "www.example.com",
                dns: Cloudflare.DNS.Adapter({ zone, proxied: true }),
              },
            });
          }),
        );
        expect(
          yield* resolve(
            compiled,
            compiled.resources["Web/CertificateValidation"]!.Props.zone,
          ),
        ).toBe("<Zone.zoneId>");
        expect(yield* propsOf(compiled, "Web/AliasRecord1-CNAME")).toEqual({
          zone: "<Zone.zoneId>",
          proxied: true,
          type: "CNAME",
          content: "<Web/Distribution.domainName>",
          names: ["www.example.com"],
        });
      }),
    );

    test(
      "a StaticSite on Hetzner DNS publishes through Hetzner.DNS.RecordList",
      Effect.gen(function* () {
        const compiled = yield* compileStack(
          AWS.Website.StaticSite("Web", {
            path: fixtureDir,
            domain: {
              name: "www.example.com",
              dns: Hetzner.DNS.Adapter({ zone: "example.com" }),
            },
          }),
        );
        const types = typesOf(compiled);
        expect(types["Web/CertificateValidation"]).toBe(
          "Hetzner.DNS.RecordList",
        );
        expect(types["Web/AliasRecord1-CNAME"]).toBe("Hetzner.DNS.RecordList");
        expect(yield* propsOf(compiled, "Web/AliasRecord1-CNAME")).toEqual({
          zone: "example.com",
          names: ["www.example.com"],
          target: "<Web/Distribution.domainName>",
        });
      }),
    );

    test(
      "a StaticSite without `dns` keeps the Route 53 path unchanged",
      Effect.gen(function* () {
        const compiled = yield* compileStack(
          AWS.Website.StaticSite("Web", {
            path: fixtureDir,
            domain: { name: "www.example.com", hostedZoneId: "Z1234567890ABC" },
          }),
        );
        const certificate = compiled.resources["Web/Certificate"]!;
        expect(certificate.Props.hostedZoneId).toBe("Z1234567890ABC");
        expect("dnsValidation" in certificate.Props).toBe(false);
        expect(compiled.resources["Web/CertificateIssued"]).toBeUndefined();

        const record = compiled.resources["Web/AliasRecord1"]!;
        expect(record.Type).toBe("AWS.Route53.Record");
        expect(record.Props.hostedZoneId).toBe("Z1234567890ABC");
        expect(record.Props.type).toBe("A");
        expect("evaluateTargetHealth" in record.Props.aliasTarget).toBe(false);
      }),
    );

    test(
      "`dns: false` creates no records",
      Effect.gen(function* () {
        const compiled = yield* compileStack(
          AWS.Website.StaticSite("Web", {
            path: fixtureDir,
            domain: {
              name: "www.example.com",
              cert: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
              dns: false,
            },
          }),
        );
        const types = Object.values(typesOf(compiled));
        expect(types).not.toContain("AWS.Route53.Record");
        expect(types).not.toContain("Cloudflare.DNS.Records");
        expect(types).not.toContain("AWS.ACM.Certificate");
      }),
    );

    test(
      "a Router on Cloudflare DNS exposes a Cloudflare record set that attached sites bind onto",
      Effect.gen(function* () {
        const compiled = yield* compileStack(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("Router", {
              domain: {
                name: "router.example.com",
                dns: Cloudflare.DNS.Adapter(),
              },
            });
            yield* AWS.Website.StaticSite("DocsSite", {
              path: fixtureDir,
              domain: { name: "docs.example.com", router, path: "/docs" },
            });
            return {};
          }),
        );
        const types = typesOf(compiled);

        expect(
          compiled.resources["Router/Certificate"]?.Props.dnsValidation,
        ).toBe("external");
        expect(types["Router/CertificateValidation"]).toBe(
          "Cloudflare.DNS.RecordList",
        );
        expect(types["Router/CertificateIssued"]).toBe(
          "AWS.ACM.CertificateValidation",
        );
        expect(types["Router/AliasRecord1-CNAME"]).toBe(
          "Cloudflare.DNS.Records",
        );
        expect(types["Router/SiteAliasRecords-CNAME"]).toBe(
          "Cloudflare.DNS.Records",
        );
        expect(
          yield* propsOf(compiled, "Router/SiteAliasRecords-CNAME"),
        ).toEqual({
          type: "CNAME",
          content: "<Router/Distribution.domainName>",
        });

        const recordsRow = (
          compiled.bindings["Router/SiteAliasRecords-CNAME"] ?? []
        ).find((row) => row.sid === "AWS.Website.Site(DocsSite)");
        expect(recordsRow?.data.names).toEqual(["docs.example.com"]);
        const certificateRow = (
          compiled.bindings["Router/Certificate"] ?? []
        ).find((row) => row.sid === "AWS.Website.Site(DocsSite)");
        expect(certificateRow?.data.subjectAlternativeNames).toEqual([
          "docs.example.com",
        ]);
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Live verification — gated on AWS_TEST_SLOW=1: a CloudFront
// distribution takes several minutes to deploy and to delete.
// ---------------------------------------------------------------------------

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const SITE_NAME = `alchemy-cf-staticsite.${zoneName}`;

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

class SiteNotServing extends Data.TaggedError("SiteNotServing")<{
  readonly status: number;
}> {}

class CnameNotPublished extends Data.TaggedError("CnameNotPublished")<{
  readonly server: string;
}> {}

/**
 * Wait until every authoritative nameserver of the zone answers the CNAME,
 * so the first HTTPS request never resolves (and negatively caches) the
 * hostname before it exists.
 */
const waitForAuthoritativeCname = (name: string, target: string) =>
  Effect.gen(function* () {
    const nameServers = yield* Effect.tryPromise(() =>
      resolveNs(zoneName),
    ).pipe(Effect.orDie);
    const servers = (yield* Effect.forEach(nameServers, (ns) =>
      Effect.tryPromise(() => resolve4(ns)).pipe(Effect.orDie),
    )).flat();
    yield* Effect.forEach(servers, (server) =>
      Effect.gen(function* () {
        const resolver = yield* Effect.sync(() => {
          const r = new Resolver();
          r.setServers([server]);
          return r;
        });
        const answers = yield* Effect.tryPromise(() =>
          resolver.resolveCname(name),
        ).pipe(Effect.orElseSucceed(() => [] as string[]));
        if (
          !answers.some(
            (answer) =>
              answer.replace(/\.$/, "").toLowerCase() === target.toLowerCase(),
          )
        ) {
          return yield* Effect.fail(new CnameNotPublished({ server }));
        }
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
      ),
    );
  });

const listSiteCnames = (zoneId: string) =>
  dns.listRecords
    .items({ zoneId, name: { exact: SITE_NAME }, type: "CNAME" })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

describe.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "AWS.Website Cloudflare DNS (live)",
  {
    tags: [
      "provider:aws",
      "provider:aws:acm",
      "provider:aws:cloudfront",
      "provider:aws:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
  },
  () => {
    test.provider(
      "a StaticSite on a Cloudflare domain is served over HTTPS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const zoneId = yield* resolveZoneId;

          const site = yield* stack.deploy(
            AWS.Website.StaticSite("CloudflareSite", {
              path: fixtureDir,
              domain: { name: SITE_NAME, dns: Cloudflare.DNS.Adapter() },
            }),
          );
          expect(site.url).toBe(`https://${SITE_NAME}`);

          // The CNAME points at the distribution and stays DNS-only.
          const [cname] = yield* listSiteCnames(zoneId);
          expect(cname?.content).toMatch(/\.cloudfront\.net$/);
          expect(cname?.proxied).toBe(false);

          yield* waitForAuthoritativeCname(SITE_NAME, cname!.content!);

          // The distribution's edge rollout needs a few minutes — bounded
          // retry until the custom hostname serves.
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(`https://${SITE_NAME}/`).pipe(
            Effect.flatMap((res): Effect.Effect<number, unknown> =>
              res.status === 200
                ? Effect.succeed(res.status)
                : Effect.fail(new SiteNotServing({ status: res.status })),
            ),
            Effect.retry({
              schedule: Schedule.spaced("10 seconds"),
              times: 60,
            }),
          );
          expect(response).toBe(200);

          yield* stack.destroy();
          expect(yield* listSiteCnames(zoneId)).toHaveLength(0);
        }),
      { timeout: 1_200_000 },
    );
  },
);
