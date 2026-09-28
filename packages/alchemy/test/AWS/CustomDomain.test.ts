/**
 * Zero-change upgrade guarantee for Route 53 custom domains.
 *
 * DNS adapters rerouted every AWS composite's custom domain through
 * `AWS/CustomDomain.ts`. A domain without `dns` (Route 53, the default)
 * must declare EXACTLY what the composites declared before — same resource
 * types, logical ids, and props — so existing stacks plan no changes.
 *
 * The expectations below are the declarations of `origin/main` before the
 * adapter change (inline `Certificate(...)`, `Route53Record("AliasRecord{n}")`,
 * `Route53Records("SiteAliasRecords")`, ECS `Domain-{name}-A|AAAA`).
 * Plan-level only: each case compiles the program (registration — no plan,
 * no apply, no cloud calls) and resolves Output references to
 * `<fqn.attr>` placeholders.
 */
import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Output from "@/Output";
import type { ResourceBinding, ResourceLike } from "@/Resource";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState, InMemoryService, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { fileURLToPath } from "node:url";

const { test } = Test.make({ providers: AWS.providers() });

// Anchor the fixture to the repo root regardless of the runner's cwd.
const fixtureDir = fileURLToPath(
  new URL("../../../../examples/aws-static-site/site", import.meta.url),
);

interface Compiled {
  resources: Record<string, ResourceLike>;
  bindings: Record<string, ResourceBinding[]>;
}

const compile = (
  build: Effect.Effect<unknown, any, any>,
): Effect.Effect<Compiled> =>
  Effect.scoped(
    (build as Effect.Effect<unknown>).pipe(
      Stack.make({
        name: "custom-domain-upgrade",
        providers: Layer.empty,
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
    Object.entries(compiled.resources).map(([fqn, r]) => [fqn, r.Type]),
  );

/** Domain-related resources only (certificates and DNS records). */
const domainTypesOf = (compiled: Compiled) =>
  Object.entries(typesOf(compiled)).filter(([, type]) =>
    /Route53|ACM|DNS/.test(type),
  );

/**
 * Assert a resource's resolved props equal `expected` — including which
 * keys are present, since a key that appears or disappears (even as
 * `undefined`) is exactly the kind of drift this suite guards against.
 */
const expectProps = (
  compiled: Compiled,
  fqn: string,
  expected: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const resource = compiled.resources[fqn];
    expect(resource).toBeDefined();
    const props = yield* resolve(compiled, resource!.Props);
    expect(props).toEqual(expected);
    expect(Object.keys(props).sort()).toEqual(Object.keys(expected).sort());
    expect(resource!.RemovalPolicy).toBe("destroy");
  });

const distributionDomain = (compiled: Compiled, fqn: string) =>
  resolve(compiled, compiled.resources[fqn]!.Props).pipe(
    Effect.map((props) => ({
      aliases: props.aliases,
      viewerCertificate: props.viewerCertificate,
    })),
  );

const aliasRecord = (
  site: string,
  name: string,
  hostedZoneId?: string,
): Record<string, unknown> => ({
  hostedZoneId,
  name,
  type: "A",
  aliasTarget: {
    hostedZoneId: `<${site}/Distribution.hostedZoneId>`,
    dnsName: `<${site}/Distribution.domainName>`,
  },
});

const viewerCertificate = (acmCertificateArn: string) => ({
  acmCertificateArn,
  sslSupportMethod: "sni-only",
  minimumProtocolVersion: "TLSv1.2_2021",
});

const tags = ["unit", "provider:aws", "provider:aws:website", "local"];

describe("Route 53 custom domains: zero-change upgrade", { tags }, () => {
  test(
    "StaticSite with a pinned hosted zone",
    Effect.gen(function* () {
      const compiled = yield* compile(
        AWS.Website.StaticSite("Web", {
          path: fixtureDir,
          domain: {
            name: "www.example.com",
            aliases: ["example.com"],
            redirects: ["old.example.com"],
            hostedZoneId: "Z123",
          },
        }),
      );
      expect(typesOf(compiled)).toEqual({
        "Web/Bucket": "AWS.S3.Bucket",
        "Web/Files": "AWS.Website.AssetDeployment",
        "Web/Certificate": "AWS.ACM.Certificate",
        "Web/KvStore": "AWS.CloudFront.KeyValueStore",
        "Web/ViewerRequest": "AWS.CloudFront.Function",
        "Web/OriginAccessControl": "AWS.CloudFront.OriginAccessControl",
        "Web/Distribution": "AWS.CloudFront.Distribution",
        "Web/AliasRecord1": "AWS.Route53.Record",
        "Web/AliasRecord2": "AWS.Route53.Record",
        "Web/AliasRecord3": "AWS.Route53.Record",
        "Web/KvEntries": "AWS.CloudFront.KvEntries",
        "Web/Invalidation": "AWS.CloudFront.Invalidation",
      });
      yield* expectProps(compiled, "Web/Certificate", {
        domainName: "www.example.com",
        subjectAlternativeNames: ["example.com", "old.example.com"],
        hostedZoneId: "Z123",
        tags: undefined,
      });
      for (const [index, name] of [
        "www.example.com",
        "example.com",
        "old.example.com",
      ].entries()) {
        yield* expectProps(
          compiled,
          `Web/AliasRecord${index + 1}`,
          aliasRecord("Web", name, "Z123"),
        );
      }
      expect(yield* distributionDomain(compiled, "Web/Distribution")).toEqual({
        aliases: ["www.example.com", "example.com", "old.example.com"],
        viewerCertificate: viewerCertificate(
          "<Web/Certificate.certificateArn>",
        ),
      });
    }),
  );

  test(
    "StaticSite with a string domain (inferred zone)",
    Effect.gen(function* () {
      const compiled = yield* compile(
        AWS.Website.StaticSite("Web", {
          path: fixtureDir,
          domain: "app.example.com",
          tags: { team: "web" },
        }),
      );
      expect(domainTypesOf(compiled)).toEqual([
        ["Web/Certificate", "AWS.ACM.Certificate"],
        ["Web/AliasRecord1", "AWS.Route53.Record"],
      ]);
      yield* expectProps(compiled, "Web/Certificate", {
        domainName: "app.example.com",
        subjectAlternativeNames: [],
        hostedZoneId: undefined,
        tags: { team: "web" },
      });
      yield* expectProps(
        compiled,
        "Web/AliasRecord1",
        aliasRecord("Web", "app.example.com"),
      );
    }),
  );

  test(
    "StaticSite with `dns: false` declares no records",
    Effect.gen(function* () {
      const cert = "arn:aws:acm:us-east-1:123456789012:certificate/abc";
      const compiled = yield* compile(
        AWS.Website.StaticSite("Web", {
          path: fixtureDir,
          domain: { name: "app.example.com", cert, dns: false },
        }),
      );
      expect(domainTypesOf(compiled)).toEqual([]);
      expect(yield* distributionDomain(compiled, "Web/Distribution")).toEqual({
        aliases: ["app.example.com"],
        viewerCertificate: viewerCertificate(cert),
      });
    }),
  );

  test(
    "Router with aliases, redirects, and an attached site (SiteAliasRecords)",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const router = yield* AWS.Website.Router("Router", {
            domain: {
              name: "router.example.com",
              aliases: ["r2.example.com"],
              redirects: ["r3.example.com"],
            },
          });
          yield* AWS.Website.StaticSite("DocsSite", {
            path: fixtureDir,
            domain: { name: "docs.example.com", router, path: "/docs" },
          });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        "Router/Certificate": "AWS.ACM.Certificate",
        "Router/KvStore": "AWS.CloudFront.KeyValueStore",
        "Router/ViewerRequest": "AWS.CloudFront.Function",
        "Router/CachePolicy": "AWS.CloudFront.CachePolicy",
        "Router/Distribution": "AWS.CloudFront.Distribution",
        "Router/AliasRecord1": "AWS.Route53.Record",
        "Router/AliasRecord2": "AWS.Route53.Record",
        "Router/AliasRecord3": "AWS.Route53.Record",
        "Router/SiteAliasRecords": "AWS.Route53.Records",
        "DocsSite/Bucket": "AWS.S3.Bucket",
        "DocsSite/Files": "AWS.Website.AssetDeployment",
        "DocsSite/RoutesUpdate": "AWS.CloudFront.KvRoutesUpdate",
        "DocsSite/KvEntries": "AWS.CloudFront.KvEntries",
        "DocsSite/Invalidation": "AWS.CloudFront.Invalidation",
      });
      yield* expectProps(compiled, "Router/Certificate", {
        domainName: "router.example.com",
        subjectAlternativeNames: ["r2.example.com", "r3.example.com"],
        hostedZoneId: undefined,
        tags: undefined,
      });
      for (const [index, name] of [
        "router.example.com",
        "r2.example.com",
        "r3.example.com",
      ].entries()) {
        yield* expectProps(
          compiled,
          `Router/AliasRecord${index + 1}`,
          aliasRecord("Router", name),
        );
      }
      yield* expectProps(compiled, "Router/SiteAliasRecords", {
        hostedZoneId: undefined,
        type: "A",
        aliasTarget: {
          hostedZoneId: "<Router/Distribution.hostedZoneId>",
          dnsName: "<Router/Distribution.domainName>",
        },
      });
      // The attached site binds its hostname onto the record set and the
      // certificate, exactly as before.
      expect(
        yield* resolve(compiled, compiled.bindings["Router/SiteAliasRecords"]),
      ).toEqual([
        {
          sid: "AWS.Website.Site(DocsSite)",
          data: { names: ["docs.example.com"] },
        },
      ]);
      expect(
        yield* resolve(compiled, compiled.bindings["Router/Certificate"]),
      ).toEqual([
        {
          sid: "AWS.Website.Site(DocsSite)",
          data: { subjectAlternativeNames: ["docs.example.com"] },
        },
      ]);
      expect(
        (yield* distributionDomain(compiled, "Router/Distribution"))
          .viewerCertificate,
      ).toEqual(viewerCertificate("<Router/Certificate.certificateArn>"));
    }),
  );

  test(
    "Router with a pinned hosted zone",
    Effect.gen(function* () {
      const compiled = yield* compile(
        AWS.Website.Router("Router", {
          domain: { name: "router.example.com", hostedZoneId: "Z999" },
        }),
      );
      expect(domainTypesOf(compiled)).toEqual([
        ["Router/Certificate", "AWS.ACM.Certificate"],
        ["Router/AliasRecord1", "AWS.Route53.Record"],
        ["Router/SiteAliasRecords", "AWS.Route53.Records"],
      ]);
      yield* expectProps(compiled, "Router/Certificate", {
        domainName: "router.example.com",
        subjectAlternativeNames: [],
        hostedZoneId: "Z999",
        tags: undefined,
      });
      yield* expectProps(
        compiled,
        "Router/AliasRecord1",
        aliasRecord("Router", "router.example.com", "Z999"),
      );
      yield* expectProps(compiled, "Router/SiteAliasRecords", {
        hostedZoneId: "Z999",
        type: "A",
        aliasTarget: {
          hostedZoneId: "<Router/Distribution.hostedZoneId>",
          dnsName: "<Router/Distribution.domainName>",
        },
      });
    }),
  );

  test(
    "SsrSite with aliases",
    Effect.gen(function* () {
      const compiled = yield* compile(
        AWS.Website.SsrSite("Ssr", {
          server: { type: "url", url: "https://origin.example.net" },
          domain: { name: "ssr.example.com", aliases: ["ssr2.example.com"] },
        }),
      );
      expect(typesOf(compiled)).toEqual({
        "Ssr/Certificate": "AWS.ACM.Certificate",
        "Ssr/Distribution": "AWS.CloudFront.Distribution",
        "Ssr/AliasRecord1": "AWS.Route53.Record",
        "Ssr/AliasRecord2": "AWS.Route53.Record",
      });
      yield* expectProps(compiled, "Ssr/Certificate", {
        domainName: "ssr.example.com",
        subjectAlternativeNames: ["ssr2.example.com"],
        hostedZoneId: undefined,
        tags: undefined,
      });
      for (const [index, name] of [
        "ssr.example.com",
        "ssr2.example.com",
      ].entries()) {
        yield* expectProps(
          compiled,
          `Ssr/AliasRecord${index + 1}`,
          aliasRecord("Ssr", name),
        );
      }
      expect(yield* distributionDomain(compiled, "Ssr/Distribution")).toEqual({
        aliases: ["ssr.example.com", "ssr2.example.com"],
        viewerCertificate: viewerCertificate(
          "<Ssr/Certificate.certificateArn>",
        ),
      });
    }),
  );
});

// ECS resolves the Route 53 zone of each domain name while the program is
// built (`findPublicHostedZoneId`); answer with a canned public zone
// `example.com.` (id `ZEXAMPLE`) instead of calling AWS.
const route53ZoneXml = `<?xml version="1.0" encoding="UTF-8"?>
<ListHostedZonesByNameResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><HostedZones><HostedZone><Id>/hostedzone/ZEXAMPLE</Id><Name>example.com.</Name><CallerReference>ref</CallerReference><Config><PrivateZone>false</PrivateZone></Config><ResourceRecordSetCount>2</ResourceRecordSetCount></HostedZone></HostedZones><IsTruncated>false</IsTruncated><MaxItems>1</MaxItems></ListHostedZonesByNameResponse>`;

const cannedAws = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(route53ZoneXml, {
            status: 200,
            headers: { "content-type": "text/xml" },
          }),
        ),
      ),
    ),
  ),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-west-2" as RegionName,
    }),
  ),
  Layer.succeed(
    AWSEnvironment,
    Effect.succeed({
      accountId: "123456789012",
      region: "us-west-2",
      credentials: Effect.die("credentials are not resolved at compile time"),
    }),
  ),
);

const ecsService = (domain: {
  name: string;
  aliases?: string[];
  cert?: string;
}) =>
  Effect.gen(function* () {
    const cluster = yield* Cluster("Cluster", { clusterName: "upgrade" });
    yield* Service("Api", {
      cluster,
      image: "busybox:stable",
      port: 80,
      vpcId: "vpc-0123456789abcdef0",
      subnets: ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"],
      loadBalancer: { domain },
    });
  });

const loadBalancerAlias = (name: string, type: "A" | "AAAA") => ({
  hostedZoneId: "ZEXAMPLE",
  name,
  type,
  aliasTarget: {
    hostedZoneId: "<Api/LoadBalancer.canonicalHostedZoneId>",
    dnsName: "<Api/LoadBalancer.dnsName>",
    evaluateTargetHealth: false,
  },
});

describe(
  "AWS.ECS.Service Route 53 domain: zero-change upgrade",
  { tags: ["unit", "provider:aws", "provider:aws:ecs", "local"] },
  () => {
    test(
      "a composed certificate plus dual-stack alias records per name",
      Effect.gen(function* () {
        const compiled = yield* compile(
          ecsService({
            name: "api.example.com",
            aliases: ["www.api.example.com"],
          }),
        ).pipe(Effect.provide(cannedAws));
        expect(typesOf(compiled)).toEqual({
          Cluster: "AWS.ECS.Cluster",
          Api: "AWS.ECS.Service",
          "Api/Certificate": "AWS.ACM.Certificate",
          "Api/SecurityGroup": "AWS.EC2.SecurityGroup",
          "Api/TargetGroup": "AWS.ELBv2.TargetGroup",
          "Api/LoadBalancer": "AWS.ELBv2.LoadBalancer",
          "Api/Listener-443": "AWS.ELBv2.Listener",
          "Api/Domain-api-example-com-A": "AWS.Route53.Record",
          "Api/Domain-api-example-com-AAAA": "AWS.Route53.Record",
          "Api/Domain-www-api-example-com-A": "AWS.Route53.Record",
          "Api/Domain-www-api-example-com-AAAA": "AWS.Route53.Record",
        });
        yield* expectProps(compiled, "Api/Certificate", {
          domainName: "api.example.com",
          subjectAlternativeNames: ["www.api.example.com"],
          hostedZoneId: "ZEXAMPLE",
          region: "us-west-2",
          tags: undefined,
        });
        for (const name of ["api.example.com", "www.api.example.com"]) {
          const sanitized = name.replaceAll(".", "-");
          for (const type of ["A", "AAAA"] as const) {
            yield* expectProps(
              compiled,
              `Api/Domain-${sanitized}-${type}`,
              loadBalancerAlias(name, type),
            );
          }
        }
        const listener = yield* resolve(
          compiled,
          compiled.resources["Api/Listener-443"]!.Props,
        );
        expect(listener.certificateArn).toBe(
          "<Api/Certificate.certificateArn>",
        );
      }),
    );

    test(
      "a user-provided certificate composes no certificate",
      Effect.gen(function* () {
        const cert = "arn:aws:acm:us-west-2:123456789012:certificate/abc";
        const compiled = yield* compile(
          ecsService({ name: "api.example.com", cert }),
        ).pipe(Effect.provide(cannedAws));
        expect(domainTypesOf(compiled)).toEqual([
          ["Api/Domain-api-example-com-A", "AWS.Route53.Record"],
          ["Api/Domain-api-example-com-AAAA", "AWS.Route53.Record"],
        ]);
        for (const type of ["A", "AAAA"] as const) {
          yield* expectProps(
            compiled,
            `Api/Domain-api-example-com-${type}`,
            loadBalancerAlias("api.example.com", type),
          );
        }
        const listener = yield* resolve(
          compiled,
          compiled.resources["Api/Listener-443"]!.Props,
        );
        expect(listener.certificateArn).toBe(cert);
      }),
    );
  },
);
