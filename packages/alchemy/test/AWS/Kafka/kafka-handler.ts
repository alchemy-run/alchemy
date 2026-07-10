import * as AWS from "@/AWS";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { getDefaultVpc } from "../DefaultVpc.ts";

export class KafkaTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "KafkaTestFunction",
) {}

export class FixtureCluster extends Context.Service<
  FixtureCluster,
  { cluster: AWS.Kafka.ServerlessCluster }
>()("FixtureCluster") {}

/**
 * Resolve two default-for-AZ subnets from the account's default VPC — MSK
 * requires at least two subnets in distinct AZs. Runtime-guarded: the Lambda
 * runtime re-executes this props effect on cold start with no ec2:Describe*
 * permission, so return an empty list there (VPC config is deploy-time only).
 */
const resolveSubnets = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return [] as string[];
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const byAz = new Map<string, string>();
  for (const s of subnets.Subnets ?? []) {
    if (s.AvailabilityZone && s.SubnetId && !byAz.has(s.AvailabilityZone)) {
      byAz.set(s.AvailabilityZone, s.SubnetId);
    }
  }
  return [...byAz.values()].slice(0, 3);
}).pipe(
  // Deploy-time lookup only; a failure here is a fixture defect, not a typed
  // error the Function impl contract can carry.
  Effect.orDie,
);

export const FixtureClusterLive = Layer.effect(
  FixtureCluster,
  Effect.gen(function* () {
    const subnetIds = yield* resolveSubnets;
    const cluster = yield* AWS.Kafka.ServerlessCluster("FixtureCluster", {
      subnetIds,
      tags: { fixture: "kafka-serverless" },
    });
    return { cluster };
  }),
);

export default KafkaTestFunction.make(
  { main: import.meta.url, url: true },
  Effect.gen(function* () {
    const { cluster } = yield* FixtureCluster;

    // Wire the "orders" topic to this function. At deploy time this grants MSK
    // IAM-auth actions and creates the event source mapping; at runtime it
    // registers the record handler below.
    yield* AWS.Kafka.consumeKafkaTopic(
      cluster,
      { topics: ["orders"], consumerGroupId: "alchemy-fixture" },
      (records) => records.pipe(Stream.runForEach((r) => Effect.log(r.value))),
    );

    const ClusterArn = cluster.clusterArn;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl ?? request.url, "http://x");
        if (url.pathname === "/cluster") {
          const clusterArn = yield* ClusterArn;
          return yield* HttpServerResponse.json({ clusterArn });
        }
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(AWS.Lambda.KafkaEventSource),
        FixtureClusterLive,
      ),
    ),
  ),
);
