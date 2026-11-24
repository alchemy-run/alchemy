/**
 * Effect Cluster on AWS in a VPC the user declares, with each kind of
 * gateway: an internal load balancer, CloudFront in front of one, and a
 * load balancer serving HTTPS on a domain (DNS in Cloudflare). A Lambda
 * function in the VPC calls each pool; long calls show the gateway keeps a
 * waiting call open through CloudFront.
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as rds from "@distilled.cloud/aws/rds";
import * as State from "alchemy/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { SECURE_DOMAIN } from "./fixtures/aws-gateways/cluster.ts";
import Front from "./fixtures/aws-gateways/front.ts";
import { Lives } from "./fixtures/aws-gateways/index.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers(), Cluster.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterAwsGateways", import.meta.url);

let baseUrl = "";

/** Out-of-band reads run with the AWS credentials and region the stack deploys with. */
const aws = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

/** Every resource of `type` the stack deployed, by its logical id, from its state. */
const deployed = <A>(type: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State.State;
    const at = { stack: sharedStack.name, stage: sharedStack.stage };
    const rows = new Map<string, A>();
    for (const fqn of yield* state.list(at)) {
      const row = yield* state.get({ ...at, fqn });
      if (State.isResourceState(row) && row.resourceType === type && row.attr) {
        rows.set(fqn.split("/").at(-1)!, row.attr as A);
      }
    }
    return rows;
  }).pipe(Effect.provide(sharedStack.state));

class FrontNotReady extends Data.TaggedError("FrontNotReady")<{
  readonly status: number;
  readonly body: string;
}> {}

/** Call the front, retrying while the gateways come up. */
const call = Effect.fn(function* (path: string, attempts = 30) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? (response.json as Effect.Effect<{ value: unknown; elapsedMs: number }>)
        : Effect.flatMap(response.text, (body) =>
            Effect.fail(new FrontNotReady({ status: response.status, body })),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: attempts }),
  );
});

const balancerOf = Effect.fn(function* (pool: string) {
  const balancers = yield* deployed<{ loadBalancerArn: string }>("AWS.ELBv2.LoadBalancer");
  const { loadBalancerArn } = balancers.get(`${pool}GatewayBalancer`)!;
  const { LoadBalancers } = yield* aws(
    elbv2.describeLoadBalancers({ LoadBalancerArns: [loadBalancerArn] }),
  );
  return LoadBalancers![0]!;
});

const gatewayOf = Effect.fn(function* (entityType: string) {
  const entities = yield* deployed<{ gateway?: string }>("Cluster.Entity");
  return entities.get(entityType)?.gateway;
});

describe.skipIf(!!process.env.FAST)(
  "Effect Cluster gateways on AWS (VPC, internal, CloudFront, HTTPS)",
  { tags: ["provider:cluster", "provider:aws", "provider:cloudflare", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { url: front.functionUrl };
          }).pipe(Effect.provide(Lives)),
        );
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
      }),
      { timeout: 2_400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 1_800_000 });

    test(
      "the database, the runners and the front share the network the user declared",
      Effect.gen(function* () {
        // The database and the front yield the same `EC2.Network`.
        const vpcs = yield* deployed<{ vpcId: string }>("AWS.EC2.Vpc");
        expect(vpcs.size).toBe(1);
        const [{ vpcId }] = [...vpcs.values()];
        const { Vpcs } = yield* aws(ec2.describeVpcs({ VpcIds: [vpcId!] }));
        expect(Vpcs?.[0]?.CidrBlock).toBe("10.45.0.0/16");

        // Behind the NAT gateway: the network's private subnets.
        const subnets = yield* deployed<{ subnetId: string; mapPublicIpOnLaunch?: boolean }>(
          "AWS.EC2.Subnet",
        );
        const { Subnets } = yield* aws(
          ec2.describeSubnets({ SubnetIds: [...subnets.values()].map((s) => s.subnetId) }),
        );
        const privateSubnets = (Subnets ?? [])
          .filter((subnet) => subnet.MapPublicIpOnLaunch !== true)
          .map((subnet) => subnet.SubnetId!)
          .sort();
        expect(privateSubnets.length).toBe(2);

        const groups = yield* deployed<{ dbSubnetGroupName: string }>("AWS.RDS.DBSubnetGroup");
        const [{ dbSubnetGroupName }] = [...groups.values()];
        const { DBSubnetGroups } = yield* aws(
          rds.describeDBSubnetGroups({ DBSubnetGroupName: dbSubnetGroupName! }),
        );
        expect(DBSubnetGroups?.[0]?.Subnets?.map((s) => s.SubnetIdentifier!).sort()).toEqual(
          privateSubnets,
        );

        const services = yield* deployed<{ clusterArn: string; serviceName: string }>(
          "AWS.ECS.Service",
        );
        expect(services.size).toBe(3);
        for (const { clusterArn, serviceName } of services.values()) {
          const described = yield* aws(
            ecs.describeServices({ cluster: clusterArn, services: [serviceName] }),
          );
          const network = described.services?.[0]?.networkConfiguration?.awsvpcConfiguration;
          expect(network?.assignPublicIp).toBe("DISABLED");
          expect([...(network?.subnets ?? [])].sort()).toEqual(privateSubnets);
        }
      }),
      { timeout: 120_000 },
    );

    test(
      "an internal load balancer gateway admits only the VPC, and serves a caller in it",
      Effect.gen(function* () {
        const balancer = yield* balancerOf("Private");
        expect(balancer.Scheme).toBe("internal");
        const { SecurityGroups } = yield* aws(
          ec2.describeSecurityGroups({ GroupIds: [...(balancer.SecurityGroups ?? [])] }),
        );
        const ingress = (SecurityGroups ?? []).flatMap((group) => group.IpPermissions ?? []);
        expect(ingress.flatMap((rule) => (rule.IpRanges ?? []).map((r) => r.CidrIp))).toEqual([
          "10.45.0.0/16",
        ]);
        expect(yield* gatewayOf("PrivateWaiter")).toMatch(/^http:\/\/internal-/);
        expect((yield* call("/private/sleep/1")).value).toBe(1);
      }),
      { timeout: 600_000 },
    );

    test(
      "a CloudFront gateway serves HTTPS on cloudfront.net, in front of an internal load balancer",
      Effect.gen(function* () {
        expect((yield* balancerOf("Edge")).Scheme).toBe("internal");
        expect(yield* gatewayOf("EdgeWaiter")).toMatch(/^https:\/\/[a-z0-9]+\.cloudfront\.net$/);
        expect((yield* call("/edge/sleep/1")).value).toBe(1);
      }),
      { timeout: 600_000 },
    );

    test(
      "a call through CloudFront that waits past its origin read timeout still answers",
      Effect.gen(function* () {
        // 75 seconds without a reply, and a stream silent for 70 seconds
        // between values: CloudFront cuts an origin silent for 60.
        const slept = yield* call("/edge/sleep/75?id=long", 2);
        expect(slept.value).toBe(75);
        expect(slept.elapsedMs).toBeGreaterThanOrEqual(75_000);
        const dripped = yield* call("/edge/drip/2/70?id=long", 2);
        expect(dripped.value).toEqual([1, 2]);
        expect(dripped.elapsedMs).toBeGreaterThanOrEqual(70_000);
      }),
      { timeout: 900_000 },
    );

    test(
      "a load balancer gateway with a domain serves HTTPS on it",
      Effect.gen(function* () {
        const balancer = yield* balancerOf("Secure");
        expect(balancer.Scheme).toBe("internet-facing");
        const { Listeners } = yield* aws(
          elbv2.describeListeners({ LoadBalancerArn: balancer.LoadBalancerArn! }),
        );
        expect(Listeners?.map((l) => [l.Port, l.Protocol])).toEqual([[443, "HTTPS"]]);
        expect(Listeners?.[0]?.Certificates?.length).toBe(1);
        expect(yield* gatewayOf("SecureWaiter")).toBe(`https://${SECURE_DOMAIN}`);
        expect((yield* call("/secure/sleep/1")).value).toBe(1);
      }),
      { timeout: 600_000 },
    );
  },
);
