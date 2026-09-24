/**
 * `Cloudflare.DNS.Adapter()` on AWS website composites: a domain whose DNS
 * lives in Cloudflare (e.g. a Cloudflare Registrar domain) pointed at a
 * CloudFront distribution.
 *
 * The ungated tests compile real compositions (registration only — no cloud
 * calls) and assert on the resources and binding rows the engine collects.
 *
 * The live suite is gated behind AWS_TEST_SLOW=1 (CloudFront deploys take
 * minutes — speed doctrine) and uses the standing Cloudflare test zone.
 */
import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State";
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
import { fileURLToPath } from "node:url";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

// Anchor the fixture to the repo root regardless of the runner's cwd.
const fixtureDir = fileURLToPath(
  new URL("../../../../../examples/aws-static-site/site", import.meta.url),
);

interface BindingRow {
  sid: string;
  data: any;
}

interface CompiledResource {
  Type: string;
  Props: any;
}

/**
 * Compile a composition (registration only — no plan, no apply, no cloud
 * calls) and return the resources and binding rows the engine collected,
 * keyed by FQN. Mirrors the harness in RouterHostnameBinding.test.ts.
 */
const compileStack = (
  build: Effect.Effect<any, any, any>,
): Effect.Effect<
  {
    bindings: Record<string, BindingRow[]>;
    resources: Record<string, CompiledResource>;
  },
  never,
  never
> =>
  Effect.scoped(
    (build as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name: "cloudflare-dns-website",
        providers: Layer.empty,
        state: inMemoryState(),
      } as any),
      Effect.map((compiled: any) => ({
        bindings: compiled.bindings as Record<string, BindingRow[]>,
        resources: compiled.resources as Record<string, CompiledResource>,
      })),
    ),
  ).pipe(Effect.provideService(Stage, "test")) as Effect.Effect<
    {
      bindings: Record<string, BindingRow[]>;
      resources: Record<string, CompiledResource>;
    },
    never,
    never
  >;

const typesOf = (resources: Record<string, CompiledResource>) =>
  Object.fromEntries(
    Object.entries(resources).map(([fqn, resource]) => [fqn, resource.Type]),
  );

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
        const { resources } = yield* compileStack(
          AWS.Website.StaticSite("Web", {
            path: fixtureDir,
            domain: {
              name: "www.example.com",
              aliases: ["example.com"],
              redirects: ["old.example.com"],
              dns: Cloudflare.DNS.Adapter({ zone: "example.com" }),
            },
          }),
        );
        const types = typesOf(resources);

        const certificate = resources["Web/Certificate"]!;
        expect(certificate.Type).toBe("AWS.ACM.Certificate");
        expect(certificate.Props.dnsValidation).toEqual({
          type: "Cloudflare.DNS",
          zone: "example.com",
        });

        for (const [index, name] of [
          "www.example.com",
          "example.com",
          "old.example.com",
        ].entries()) {
          const record = resources[`Web/AliasRecord${index + 1}-CNAME`]!;
          expect(record.Type).toBe("Cloudflare.DNS.Records");
          expect(record.Props.type).toBe("CNAME");
          expect(record.Props.names).toEqual([name]);
          expect(record.Props.zone).toBe("example.com");
        }
        expect(Object.values(types)).not.toContain("AWS.Route53.Record");
      }),
    );

    test(
      "a zone resource reference flows into the validator and records",
      Effect.gen(function* () {
        const { resources } = yield* compileStack(
          Effect.gen(function* () {
            const zone = yield* Cloudflare.Zone.Zone("Zone", {
              name: "example.com",
            });
            return yield* AWS.Website.StaticSite("Web", {
              path: fixtureDir,
              domain: {
                name: "www.example.com",
                dns: Cloudflare.DNS.Adapter({ zone }),
              },
            });
          }),
        );
        // The Zone resource itself is the reference — resolved to its
        // attributes (`{ zoneId, ... }`) at plan time.
        expect(resources["Web/Certificate"]?.Props.dnsValidation.zone).toBe(
          resources["Zone"],
        );
        expect(resources["Web/AliasRecord1-CNAME"]?.Props.zone).toBe(
          resources["Zone"],
        );
      }),
    );

    test(
      "a StaticSite without `dns` keeps the Route 53 path unchanged",
      Effect.gen(function* () {
        const { resources } = yield* compileStack(
          AWS.Website.StaticSite("Web", {
            path: fixtureDir,
            domain: { name: "www.example.com", hostedZoneId: "Z1234567890ABC" },
          }),
        );
        const certificate = resources["Web/Certificate"]!;
        expect(certificate.Props.hostedZoneId).toBe("Z1234567890ABC");
        expect("dnsValidation" in certificate.Props).toBe(false);

        const record = resources["Web/AliasRecord1"]!;
        expect(record.Type).toBe("AWS.Route53.Record");
        expect(record.Props.hostedZoneId).toBe("Z1234567890ABC");
        expect(record.Props.type).toBe("A");
        expect("evaluateTargetHealth" in record.Props.aliasTarget).toBe(false);
      }),
    );

    test(
      "`dns: false` creates no records",
      Effect.gen(function* () {
        const { resources } = yield* compileStack(
          AWS.Website.StaticSite("Web", {
            path: fixtureDir,
            domain: {
              name: "www.example.com",
              cert: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
              dns: false,
            },
          }),
        );
        const types = Object.values(typesOf(resources));
        expect(types).not.toContain("AWS.Route53.Record");
        expect(types).not.toContain("Cloudflare.DNS.Records");
      }),
    );

    test(
      "a Router on Cloudflare DNS exposes a Cloudflare record set that attached sites bind onto",
      Effect.gen(function* () {
        const { resources, bindings } = yield* compileStack(
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

        expect(resources["Router/Certificate"]?.Props.dnsValidation?.type).toBe(
          "Cloudflare.DNS",
        );
        expect(resources["Router/AliasRecord1-CNAME"]?.Type).toBe(
          "Cloudflare.DNS.Records",
        );
        expect(resources["Router/SiteAliasRecords-CNAME"]?.Type).toBe(
          "Cloudflare.DNS.Records",
        );

        const recordsRow = (
          bindings["Router/SiteAliasRecords-CNAME"] ?? []
        ).find((row) => row.sid === "AWS.Website.Site(DocsSite)");
        expect(recordsRow?.data.names).toEqual(["docs.example.com"]);
        const certificateRow = (bindings["Router/Certificate"] ?? []).find(
          (row) => row.sid === "AWS.Website.Site(DocsSite)",
        );
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

          // Resolver caches and the distribution's edge rollout need a
          // moment — bounded retry until the custom hostname serves.
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(`https://${SITE_NAME}/`).pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.succeed(res)
                : Effect.fail(new SiteNotServing({ status: res.status })),
            ),
            Effect.retry({
              schedule: Schedule.exponential("2 seconds"),
              times: 10,
            }),
          );
          expect(response.status).toBe(200);

          yield* stack.destroy();
          expect(yield* listSiteCnames(zoneId)).toHaveLength(0);
        }),
      { timeout: 1_200_000 },
    );
  },
);
