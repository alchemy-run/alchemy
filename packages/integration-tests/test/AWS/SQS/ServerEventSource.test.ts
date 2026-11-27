import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as ECS from "@distilled.cloud/aws/ecs";
import * as SQS from "@distilled.cloud/aws/sqs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import ServerQueueTask, { SinkQueue, SourceQueue } from "./fixtures/server-event-source-task.ts";

const { test } = Test.make({ providers: AWS.providers() });

class QueueStillExists extends Data.TaggedError("QueueStillExists")<{
  readonly queueUrl: string;
}> {}

const defaultSubnet = Effect.gen(function* () {
  const network = yield* EC2.describeVpcs({
    Filters: [{ Name: "is-default", Values: ["true"] }],
  });
  const vpcId = network.Vpcs?.find((vpc) => vpc.IsDefault)?.VpcId;
  if (!vpcId) return yield* Effect.fail(new Error("requires a default VPC"));
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpcId] },
      { Name: "default-for-az", Values: ["true"] },
      { Name: "state", Values: ["available"] },
    ],
  });
  const subnetId = (subnets.Subnets ?? [])
    .flatMap((s) => (s.SubnetId ? [s.SubnetId] : []))
    .sort()[0];
  if (!subnetId) return yield* Effect.fail(new Error("requires a default subnet"));
  return { vpcId: AWS.EC2.VpcId(vpcId), subnetId };
});

// A server consumer with Lambda-sized settings (`batchSize` above 10, a
// `maximumBatchingWindow` above 20 seconds) must still receive: the loop caps
// each ReceiveMessage at 10 messages and a 20-second wait.
test.provider.skipIf(!!process.env.FAST)(
  "an ECS consumer with Lambda-sized batch settings receives messages",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { vpcId, subnetId } = yield* defaultSubnet;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* SourceQueue;
          const sink = yield* SinkQueue;
          const cluster = yield* AWS.ECS.Cluster("SQSServerQueueCluster");
          const securityGroup = yield* AWS.EC2.SecurityGroup("SQSServerQueueSecurityGroup", {
            vpcId,
            description: "SQS consumer with outbound access only",
            ingress: [],
            egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
          });
          const task = yield* ServerQueueTask;
          const service = yield* AWS.ECS.Service("SQSServerQueueService", {
            cluster,
            task: {
              taskDefinitionArn: task.taskDefinitionArn,
              containerName: task.containerName,
              port: task.port,
            },
            desiredCount: 1,
            loadBalancer: false,
            vpcId,
            subnets: [subnetId],
            securityGroups: [securityGroup.groupId],
            assignPublicIp: true,
            deploymentStabilizationTimeout: "90 seconds",
          });
          return {
            sourceUrl: source.queueUrl,
            sinkUrl: sink.queueUrl,
            clusterArn: cluster.clusterArn,
            serviceName: service.serviceName,
          };
        }),
      );

      const bodies = Array.from({ length: 3 }, (_, i) => `server-batch-${i}`);
      yield* Effect.forEach(bodies, (MessageBody) =>
        SQS.sendMessage({ QueueUrl: deployed.sourceUrl, MessageBody }),
      );

      // Collect forwarded bodies from the sink until all three arrive.
      const received = new Set<string>();
      yield* SQS.receiveMessage({
        QueueUrl: deployed.sinkUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            for (const message of result.Messages ?? []) received.add(message.Body!);
          }),
        ),
        Effect.repeat({
          until: () => bodies.every((body) => received.has(body)),
          times: 12,
        }),
      );
      expect([...received].sort()).toEqual(bodies);

      const services = yield* ECS.describeServices({
        cluster: deployed.clusterArn,
        services: [deployed.serviceName],
      });
      expect(services.services?.[0]?.runningCount).toBe(1);

      yield* stack.destroy();

      yield* Effect.forEach([deployed.sourceUrl, deployed.sinkUrl], (QueueUrl) =>
        SQS.getQueueAttributes({ QueueUrl, AttributeNames: ["QueueArn"] }).pipe(
          Effect.flatMap(() => Effect.fail(new QueueStillExists({ queueUrl: QueueUrl }))),
          Effect.retry({
            while: (error) => error._tag === "QueueStillExists",
            schedule: Schedule.spaced("4 seconds"),
            times: 10,
          }),
          Effect.catchTag("QueueDoesNotExist", () => Effect.void),
        ),
      );
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:ecs", "provider:aws:sqs", "live"],
    timeout: 420_000,
  },
);
