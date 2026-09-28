/**
 * `AWS.ECS.Service` load-balancer domain on Cloudflare DNS
 * (`domain.dns: Cloudflare.DNS.Adapter()`).
 *
 * The ungated tests compile the composition (registration only — no cloud
 * calls): with a non-Route 53 adapter there is no composition-time hosted
 * zone lookup, the certificate is validated externally through Cloudflare,
 * and each name becomes a Cloudflare CNAME to the ALB
 * (`Domain-{name}-CNAME`).
 *
 * The live test is gated behind AWS_TEST_SLOW=1 (a real ALB + ACM issuance
 * through the standing Cloudflare test zone).
 */
import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Output from "@/Output";
import type { ResourceLike } from "@/Resource";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState, InMemoryService, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

type Resources = Record<string, ResourceLike>;

const compileStack = (
  build: Effect.Effect<unknown, any, any>,
): Effect.Effect<Resources> =>
  Effect.scoped(
    (build as Effect.Effect<unknown>).pipe(
      Stack.make({
        name: "ecs-cloudflare-domain",
        providers: Layer.mergeAll(
          Cloudflare.DNS.AdapterLive,
          AWS.Route53.AdapterLive,
        ),
        state: inMemoryState(),
      } as any) as any,
      Effect.map((compiled: any) => compiled.resources as Resources),
    ),
  ).pipe(
    Effect.provideService(Stage, "test"),
    // The certificate is requested in the service's region.
    Effect.provideService(
      AWSEnvironment,
      Effect.succeed({
        accountId: "123456789012",
        region: "us-west-2",
        credentials: Effect.die("credentials are not resolved at compile time"),
      }),
    ),
  ) as Effect.Effect<Resources>;

/** Resolve Output references: attribute `a` of resource `fqn` reads `<fqn.a>`. */
const propsOf = (resources: Resources, fqn: string) => {
  expect(resources[fqn]).toBeDefined();
  return Output.evaluate(
    resources[fqn]!.Props,
    Object.fromEntries(
      Object.keys(resources).map((key) => [
        key,
        new Proxy(
          {},
          {
            get: (_, attr) =>
              typeof attr === "string" ? `<${key}.${attr}>` : undefined,
          },
        ),
      ]),
    ),
  ).pipe(Effect.provideService(State, InMemoryService())) as Effect.Effect<any>;
};

const service = (domain: {
  name: string;
  aliases?: string[];
  cert?: string;
  dns?:
    | ReturnType<typeof Cloudflare.DNS.Adapter>
    | ReturnType<typeof AWS.Route53.Adapter>;
}) =>
  Effect.gen(function* () {
    const cluster = yield* Cluster("Cluster", {
      clusterName: "alchemy-test-ecs-cf-domain",
    });
    return yield* Service("Api", {
      cluster,
      image: "busybox:stable",
      port: 80,
      vpcId: "vpc-0123456789abcdef0",
      subnets: ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"],
      loadBalancer: { domain },
    });
  });

describe(
  "AWS.ECS.Service Cloudflare domain (composition)",
  {
    tags: [
      "unit",
      "provider:aws",
      "provider:aws:ecs",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "local",
    ],
  },
  () => {
    test(
      "each domain name becomes a Cloudflare CNAME to the load balancer",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          service({
            name: "api.example.com",
            aliases: ["www.api.example.com"],
            cert: "arn:aws:acm:us-west-2:123456789012:certificate/abc",
            dns: Cloudflare.DNS.Adapter(),
          }),
        );
        const types = Object.values(resources).map((r) => r.Type);
        expect(types).not.toContain("AWS.Route53.Record");
        expect(types).not.toContain("AWS.ACM.Certificate");

        for (const name of ["api.example.com", "www.api.example.com"]) {
          const fqn = `Api/Domain-${name.replaceAll(".", "-")}-CNAME`;
          expect(resources[fqn]?.Type).toBe("Cloudflare.DNS.Records");
          expect(yield* propsOf(resources, fqn)).toEqual({
            type: "CNAME",
            content: "<Api/LoadBalancer.dnsName>",
            names: [name],
          });
        }
      }),
    );

    test(
      "the certificate is validated through Cloudflare in the service's region",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          service({
            name: "api.example.com",
            dns: Cloudflare.DNS.Adapter({ zone: "example.com" }),
          }),
        );
        expect(resources["Api/Certificate"]?.Type).toBe("AWS.ACM.Certificate");
        expect(yield* propsOf(resources, "Api/Certificate")).toEqual({
          domainName: "api.example.com",
          subjectAlternativeNames: undefined,
          region: "us-west-2",
          tags: undefined,
          dnsValidation: "external",
        });
        expect("hostedZoneId" in resources["Api/Certificate"]!.Props).toBe(
          false,
        );
        expect(resources["Api/CertificateValidation"]?.Type).toBe(
          "Cloudflare.DNS.RecordList",
        );
        expect(resources["Api/CertificateValidation"]?.RemovalPolicy).toBe(
          "retain",
        );
        expect(resources["Api/CertificateIssued"]?.Type).toBe(
          "AWS.ACM.CertificateValidation",
        );
        // The HTTPS listener takes the certificate only once it is issued.
        expect(
          (yield* propsOf(resources, "Api/Listener-443")).certificateArn,
        ).toBe("<Api/CertificateIssued.certificateArn>");
      }),
    );

    test(
      "the Route 53 path keeps its dual-stack alias record ids",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          service({
            name: "api.example.com",
            cert: "arn:aws:acm:us-west-2:123456789012:certificate/abc",
            // A pinned zone skips the composition-time zone lookup.
            dns: AWS.Route53.Adapter({ hostedZoneId: "Z1234567890ABC" }),
          }),
        );
        for (const type of ["A", "AAAA"]) {
          const fqn = `Api/Domain-api-example-com-${type}`;
          expect(resources[fqn]?.Type).toBe("AWS.Route53.Record");
          expect(yield* propsOf(resources, fqn)).toEqual({
            hostedZoneId: "Z1234567890ABC",
            name: "api.example.com",
            type,
            aliasTarget: {
              hostedZoneId: "<Api/LoadBalancer.canonicalHostedZoneId>",
              dnsName: "<Api/LoadBalancer.dnsName>",
              evaluateTargetHealth: false,
            },
          });
        }
      }),
    );
  },
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const DOMAIN = `alchemy-ecs-cf-domain.${zoneName}`;

describe.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "AWS.ECS.Service Cloudflare domain (live)",
  {
    tags: [
      "provider:aws",
      "provider:aws:acm",
      "provider:aws:ecs",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
  },
  () => {
    test.provider(
      "validates the certificate and CNAMEs the domain to the ALB through Cloudflare",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { accountId } = yield* yield* CloudflareEnvironment;
          const zone = yield* findZoneByName({ accountId, name: zoneName });
          if (!zone) {
            return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
          }
          const net = yield* getDefaultVpcNetwork;
          const azSubnets = yield* ec2
            .describeSubnets({
              Filters: [
                { Name: "vpc-id", Values: [net.vpcId] },
                { Name: "default-for-az", Values: ["true"] },
              ],
            })
            .pipe(
              Effect.map((r) =>
                (r.Subnets ?? []).flatMap((s) =>
                  s.SubnetId ? [s.SubnetId] : [],
                ),
              ),
            );

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const cluster = yield* Cluster("CfDomainCluster", {
                clusterName: "alchemy-test-ecs-cf-domain",
              });
              const service = yield* Service("CfDomainSvc", {
                cluster,
                image: "busybox:stable",
                command: ["sh", "-c", "while true; do sleep 30; done"],
                port: 80,
                desiredCount: 0,
                vpcId: net.vpcId as string,
                subnets: azSubnets,
                loadBalancer: {
                  domain: { name: DOMAIN, dns: Cloudflare.DNS.Adapter() },
                },
              });
              return {
                url: service.url.as<string>(),
                loadBalancerArn: service.loadBalancerArn.as<string>(),
              };
            }),
          );
          expect(deployed.url).toBe(`https://${DOMAIN}`);

          const loadBalancers = yield* elbv2.describeLoadBalancers({
            LoadBalancerArns: [deployed.loadBalancerArn],
          });
          const albDns = loadBalancers.LoadBalancers?.[0]?.DNSName ?? "";
          const listCnames = dns.listRecords
            .items({ zoneId: zone.id, name: { exact: DOMAIN }, type: "CNAME" })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
          const [cname] = yield* listCnames;
          expect(cname?.content?.toLowerCase()).toBe(albDns.toLowerCase());
          expect(cname?.proxied).toBe(false);

          yield* stack.destroy();
          expect(yield* listCnames).toHaveLength(0);
        }),
      { timeout: 900_000 },
    );
  },
);
