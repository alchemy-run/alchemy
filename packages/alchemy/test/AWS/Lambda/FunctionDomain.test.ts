/**
 * `AWS.Lambda.Function` custom domains (`domain`): an API Gateway v2 HTTP
 * API front door, a regional ACM certificate, an API Gateway domain name +
 * API mapping per hostname, and alias records through the DNS host named
 * by `domain.dns`.
 *
 * The ungated tests compile real compositions (registration only — no plan,
 * no apply, no cloud calls) and assert on the resources the engine
 * collected.
 *
 * The live test is gated behind AWS_TEST_SLOW=1 (ACM issuance through the
 * standing Cloudflare test zone plus API Gateway domain activation take
 * minutes — speed doctrine).
 */
import * as AWS from "@/AWS";
import { AlchemyContext } from "@/AlchemyContext";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import { remote } from "@/ProviderMode";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { resolve4, resolveNs, Resolver } from "node:dns/promises";
import { fileURLToPath } from "node:url";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

const handlerPath = fileURLToPath(
  new URL("./fixtures/domain-handler.ts", import.meta.url),
);

interface CompiledResource {
  Type: string;
  Props: any;
}

/**
 * Compile a composition (registration only — no plan, no apply, no cloud
 * calls) and return the resources the engine collected, keyed by FQN. The
 * stack gets no resource providers, only the Cloudflare DNS adapter
 * registration a real `Cloudflare.providers()` layer contributes.
 */
const compileStack = (
  build: Effect.Effect<any, any, any>,
): Effect.Effect<Record<string, CompiledResource>, never, never> =>
  Effect.scoped(
    (
      build.pipe(Effect.provide(Cloudflare.DNS.AdapterLive)) as Effect.Effect<
        any,
        any,
        never
      >
    ).pipe(
      Stack.make({
        name: "lambda-function-domain",
        providers: Layer.empty,
        state: inMemoryState(),
      } as any),
      Effect.map(
        (compiled: any) =>
          compiled.resources as Record<string, CompiledResource>,
      ),
    ),
  ).pipe(Effect.provideService(Stage, "test")) as Effect.Effect<
    Record<string, CompiledResource>,
    never,
    never
  >;

const typesOf = (resources: Record<string, CompiledResource>) =>
  Object.fromEntries(
    Object.entries(resources).map(([fqn, resource]) => [fqn, resource.Type]),
  );

/** Simulate an `alchemy dev` run for the wrapped registration. */
const inDev = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.provideService(AlchemyContext, {
      dotAlchemy: ".alchemy",
      dev: true,
      adopt: false,
    }),
  );

/** The front door every domain composes, keyed by FQN. */
const frontDoor = {
  "Fn/Api/Api": "AWS.ApiGatewayV2.Api",
  "Fn/Api/Integration": "AWS.ApiGatewayV2.Integration",
  "Fn/Api/Default": "AWS.ApiGatewayV2.Route",
  "Fn/Api/Stage": "AWS.ApiGatewayV2.Stage",
  "Fn/Api/Permission": "AWS.Lambda.Permission",
};

describe(
  "AWS.Lambda.Function domain (composition)",
  {
    tags: [
      "unit",
      "provider:aws",
      "provider:aws:lambda",
      "provider:aws:apigatewayv2",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "local",
    ],
  },
  () => {
    test(
      "a Function without `domain` composes nothing",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          AWS.Lambda.Function("Fn", { main: handlerPath, handler: "handler" }),
        );
        expect(typesOf(resources)).toEqual({ Fn: "AWS.Lambda.Function" });
        expect("domain" in resources["Fn"]!.Props).toBe(false);
      }),
    );

    test(
      "a hostname string validates and aliases through Route 53",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          AWS.Lambda.Function("Fn", {
            main: handlerPath,
            handler: "handler",
            domain: "api.example.com",
          }),
        );
        const types = typesOf(resources);
        expect(types).toMatchObject({
          Fn: "AWS.Lambda.Function",
          ...frontDoor,
          "Fn/Certificate": "AWS.ACM.Certificate",
          "Fn/DomainName-api-example-com": "AWS.ApiGatewayV2.DomainName",
          "Fn/ApiMapping-api-example-com": "AWS.ApiGatewayV2.ApiMapping",
          "Fn/Domain-api-example-com": "AWS.Route53.Record",
        });
        // The persisted Function props keep the plain-data domain.
        expect(resources["Fn"]!.Props.domain).toBe("api.example.com");

        // Route 53 validates inline — no external validation resources.
        const certificate = resources["Fn/Certificate"]!;
        expect(certificate.Props.domainName).toBe("api.example.com");
        expect("dnsValidation" in certificate.Props).toBe(false);
        expect(Object.values(types)).not.toContain(
          "AWS.ACM.CertificateValidation",
        );

        const apiDomain = resources["Fn/DomainName-api-example-com"]!;
        expect(apiDomain.Props.domainName).toBe("api.example.com");
        expect(apiDomain.Props.domainNameConfigurations[0].EndpointType).toBe(
          "REGIONAL",
        );

        const record = resources["Fn/Domain-api-example-com"]!;
        expect(record.Props.name).toBe("api.example.com");
        expect(record.Props.type).toBe("A");
        expect(record.Props.aliasTarget).toBeDefined();
      }),
    );

    test(
      "aliases get their own domain name, mapping, SAN, and record",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          AWS.Lambda.Function("Fn", {
            main: handlerPath,
            handler: "handler",
            domain: {
              name: "api.example.com",
              aliases: ["www.api.example.com"],
              hostedZoneId: "Z1234567890ABC",
            },
          }),
        );
        expect(
          resources["Fn/Certificate"]!.Props.subjectAlternativeNames,
        ).toEqual(["www.api.example.com"]);
        expect(resources["Fn/Certificate"]!.Props.hostedZoneId).toBe(
          "Z1234567890ABC",
        );
        for (const host of ["api-example-com", "www-api-example-com"]) {
          expect(resources[`Fn/DomainName-${host}`]?.Type).toBe(
            "AWS.ApiGatewayV2.DomainName",
          );
          expect(resources[`Fn/ApiMapping-${host}`]?.Type).toBe(
            "AWS.ApiGatewayV2.ApiMapping",
          );
          const record = resources[`Fn/Domain-${host}`]!;
          expect(record.Type).toBe("AWS.Route53.Record");
          expect(record.Props.hostedZoneId).toBe("Z1234567890ABC");
        }
      }),
    );

    test(
      "Cloudflare DNS validates the certificate externally and CNAMEs the hostname",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          AWS.Lambda.Function("Fn", {
            main: handlerPath,
            handler: "handler",
            domain: {
              name: "api.alchemy-test-2.us",
              dns: Cloudflare.DNS.Adapter({ zone: "alchemy-test-2.us" }),
            },
          }),
        );
        const types = typesOf(resources);
        expect(types).toMatchObject({
          Fn: "AWS.Lambda.Function",
          ...frontDoor,
          "Fn/Certificate": "AWS.ACM.Certificate",
          "Fn/CertificateValidation": "Cloudflare.DNS.RecordList",
          "Fn/CertificateIssued": "AWS.ACM.CertificateValidation",
          "Fn/DomainName-api-alchemy-test-2-us": "AWS.ApiGatewayV2.DomainName",
          "Fn/ApiMapping-api-alchemy-test-2-us": "AWS.ApiGatewayV2.ApiMapping",
          "Fn/Domain-api-alchemy-test-2-us-CNAME": "Cloudflare.DNS.Records",
        });
        expect(Object.values(types)).not.toContain("AWS.Route53.Record");
        expect(resources["Fn/Certificate"]!.Props.dnsValidation).toBe(
          "external",
        );
        expect(resources["Fn/CertificateValidation"]!.Props.zone).toBe(
          "alchemy-test-2.us",
        );

        const cname = resources["Fn/Domain-api-alchemy-test-2-us-CNAME"]!;
        expect(cname.Props.type).toBe("CNAME");
        expect(cname.Props.names).toEqual(["api.alchemy-test-2.us"]);
        expect(cname.Props.zone).toBe("alchemy-test-2.us");

        // The DNS host is plain data in the persisted Function props.
        expect(resources["Fn"]!.Props.domain.dns).toEqual({
          type: "Cloudflare.DNS",
          zone: "alchemy-test-2.us",
        });
      }),
    );

    test(
      "a local Function under `alchemy dev` composes no front door",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          inDev(
            AWS.Lambda.Function("Fn", {
              main: handlerPath,
              handler: "handler",
              domain: "api.example.com",
            }),
          ),
        );
        expect(typesOf(resources)).toEqual({ Fn: "AWS.Lambda.Function" });
      }),
    );

    test(
      "a remote() Function under `alchemy dev` still composes its domain",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          inDev(
            AWS.Lambda.Function("Fn", {
              main: handlerPath,
              handler: "handler",
              domain: "api.example.com",
            }).pipe(remote()),
          ),
        );
        expect(resources["Fn/DomainName-api-example-com"]?.Type).toBe(
          "AWS.ApiGatewayV2.DomainName",
        );
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Live verification — gated on AWS_TEST_SLOW=1: ACM issuance through
// Cloudflare and API Gateway domain activation take minutes.
// ---------------------------------------------------------------------------

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const DOMAIN = `alchemy-lambda-fn-domain.${zoneName}`;

class DomainNotServing extends Data.TaggedError("DomainNotServing")<{
  readonly status: number;
}> {}

class CnameNotPublished extends Data.TaggedError("CnameNotPublished")<{
  readonly server: string;
}> {}

/**
 * Wait until every authoritative nameserver of the zone answers the CNAME.
 * Querying a recursive resolver first would cache the not-yet-published
 * name for the zone's negative TTL (30 minutes on Cloudflare), so the
 * HTTP check below only starts once the record is authoritative.
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

describe.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "AWS.Lambda.Function domain (live)",
  {
    tags: [
      "provider:aws",
      "provider:aws:acm",
      "provider:aws:apigatewayv2",
      "provider:aws:lambda",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
  },
  () => {
    test.provider(
      "serves the Function on a Cloudflare-hosted domain",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { accountId } = yield* yield* CloudflareEnvironment;
          const zone = yield* findZoneByName({ accountId, name: zoneName });
          if (!zone) {
            return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
          }
          const listCnames = dns.listRecords
            .items({ zoneId: zone.id, name: { exact: DOMAIN }, type: "CNAME" })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const fn = yield* AWS.Lambda.Function("DomainFn", {
                main: handlerPath,
                handler: "handler",
                functionUrl: false,
                domain: {
                  name: DOMAIN,
                  dns: Cloudflare.DNS.Adapter({ zone: zoneName }),
                },
              });
              return { domainUrl: fn.domainUrl.as<string>() };
            }),
          );
          expect(deployed.domainUrl).toBe(`https://${DOMAIN}`);

          // The CNAME points at the API Gateway regional domain, DNS-only.
          const apiDomain = yield* agw2.getDomainName({ DomainName: DOMAIN });
          const target =
            apiDomain.DomainNameConfigurations?.[0]?.ApiGatewayDomainName;
          const [cname] = yield* listCnames;
          expect(cname?.content?.toLowerCase()).toBe(target?.toLowerCase());
          expect(cname?.proxied).toBe(false);
          yield* waitForAuthoritativeCname(DOMAIN, target!);

          // Domain activation (~1 minute) and the local resolver's cache
          // need a moment — bounded retry until the custom hostname serves
          // the Function.
          const client = yield* HttpClient.HttpClient;
          const body = yield* client.get(`https://${DOMAIN}/`).pipe(
            Effect.flatMap((res): Effect.Effect<string, unknown> =>
              res.status === 200
                ? res.text
                : Effect.fail(new DomainNotServing({ status: res.status })),
            ),
            Effect.retry({
              schedule: Schedule.spaced("5 seconds"),
              times: 36,
            }),
          );
          expect(body).toBe("hello from a custom domain");

          yield* stack.destroy();

          // Out-of-band: the API Gateway domain and the CNAME are gone.
          const after = yield* agw2
            .getDomainName({ DomainName: DOMAIN })
            .pipe(Effect.result);
          expect(Result.isFailure(after)).toBe(true);
          if (Result.isFailure(after)) {
            expect(after.failure._tag).toBe("NotFoundException");
          }
          expect(yield* listCnames).toHaveLength(0);
        }),
      { timeout: 900_000 },
    );
  },
);
