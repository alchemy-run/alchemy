/**
 * `AWS.ECS.Service` load-balancer domain on Cloudflare DNS
 * (`domain.dns: Cloudflare.DNS.Adapter()`).
 *
 * The ungated test compiles the composition (registration only — no cloud
 * calls): with a non-Route 53 adapter there is no composition-time hosted
 * zone lookup, and each name becomes a Cloudflare CNAME to the ALB.
 *
 * The live test is gated behind AWS_TEST_SLOW=1 (a real ALB + ACM issuance
 * through the standing Cloudflare test zone).
 */
import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State";
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

interface CompiledResource {
  Type: string;
  Props: any;
}

const compileStack = (
  build: Effect.Effect<any, any, any>,
): Effect.Effect<Record<string, CompiledResource>, never, never> =>
  Effect.scoped(
    (build as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name: "ecs-cloudflare-domain",
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
              loadBalancer: {
                domain: {
                  name: "api.example.com",
                  aliases: ["www.api.example.com"],
                  cert: "arn:aws:acm:us-west-2:123456789012:certificate/abc",
                  dns: Cloudflare.DNS.Adapter(),
                },
              },
            });
          }),
        );
        const types = Object.values(resources).map((r) => r.Type);
        expect(types).not.toContain("AWS.Route53.Record");

        for (const name of ["api.example.com", "www.api.example.com"]) {
          const sanitized = name.replaceAll(/[^a-zA-Z0-9-]/g, "-");
          const entry = Object.entries(resources).find(([fqn]) =>
            fqn.endsWith(`Domain-${sanitized}-CNAME`),
          );
          expect(entry?.[1].Type).toBe("Cloudflare.DNS.Records");
          expect(entry?.[1].Props.type).toBe("CNAME");
          expect(entry?.[1].Props.names).toEqual([name]);
        }
      }),
    );

    test(
      "the Route 53 path keeps its dual-stack alias record ids",
      Effect.gen(function* () {
        const resources = yield* compileStack(
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
              loadBalancer: {
                domain: {
                  name: "api.example.com",
                  cert: "arn:aws:acm:us-west-2:123456789012:certificate/abc",
                  // A pinned zone skips the composition-time zone lookup.
                  dns: AWS.Route53.Adapter({ hostedZoneId: "Z1234567890ABC" }),
                },
              },
            });
          }),
        );
        for (const type of ["A", "AAAA"]) {
          const entry = Object.entries(resources).find(([fqn]) =>
            fqn.endsWith(`Domain-api-example-com-${type}`),
          );
          expect(entry?.[1].Type).toBe("AWS.Route53.Record");
          expect(entry?.[1].Props.type).toBe(type);
          expect(entry?.[1].Props.hostedZoneId).toBe("Z1234567890ABC");
          expect(entry?.[1].Props.aliasTarget.evaluateTargetHealth).toBe(false);
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
