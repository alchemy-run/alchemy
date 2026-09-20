import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as ECS from "@distilled.cloud/aws/ecs";
import * as S3 from "@distilled.cloud/aws/s3";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import ServerEventTask, {
  artifactKey,
  INCOMING_PREFIX,
  INCOMING_SUFFIX,
  PROCESSED_PREFIX,
  ServerEventBucket,
} from "./fixtures/server-event-source-task.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stackName = "S3ServerEventSource";
const stack = Core.scratchStack(
  testOptions,
  stackName,
  "test/AWS/S3/ServerEventSource.test.ts",
);

interface Deployment {
  bucketName: string;
  bucketArn: string;
  clusterArn: string;
  serviceName: string;
  taskDefinitionArn: string;
}

let deployed: Deployment | undefined;
let queueUrl: string | undefined;

// Cold Docker/ECR/Fargate startup can exceed 120s; opt in with warm build
// caches and an existing public default VPC. There is no ALB or HTTP probe.
describe
  .skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)
  .sequential("S3 Server/SQS event source on ECS", () => {
    beforeAll(
      Core.withProviders(
        Effect.gen(function* () {
          yield* stack.destroy();
          const network = yield* EC2.describeVpcs({
            Filters: [{ Name: "is-default", Values: ["true"] }],
          });
          const vpc = network.Vpcs?.find((candidate) => candidate.IsDefault);
          if (!vpc?.VpcId) {
            return yield* Effect.fail(
              new Error(
                "Server event acceptance requires an existing default VPC",
              ),
            );
          }
          const vpcId = AWS.EC2.VpcId(vpc.VpcId);
          const subnets = yield* EC2.describeSubnets({
            Filters: [
              { Name: "vpc-id", Values: [vpcId] },
              { Name: "default-for-az", Values: ["true"] },
              { Name: "state", Values: ["available"] },
            ],
          });
          const subnetIds = (subnets.Subnets ?? [])
            .flatMap((subnet) => (subnet.SubnetId ? [subnet.SubnetId] : []))
            .sort();
          if (subnetIds.length === 0) {
            return yield* Effect.fail(
              new Error(
                "Server event acceptance requires an available public default subnet",
              ),
            );
          }

          deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const bucket = yield* ServerEventBucket;
              const cluster = yield* AWS.ECS.Cluster("S3ServerEventCluster");
              const securityGroup = yield* AWS.EC2.SecurityGroup(
                "S3ServerEventSecurityGroup",
                {
                  vpcId,
                  description:
                    "S3 notification consumer with outbound access only",
                  ingress: [],
                  egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
                },
              );
              const task = yield* ServerEventTask;
              const service = yield* AWS.ECS.Service("S3ServerEventService", {
                cluster,
                task: {
                  taskDefinitionArn: task.taskDefinitionArn,
                  containerName: task.containerName,
                  port: task.port,
                },
                desiredCount: 1,
                loadBalancer: false,
                vpcId,
                subnets: [subnetIds[0]!],
                securityGroups: [securityGroup.groupId],
                assignPublicIp: true,
                deploymentStabilizationTimeout: "45 seconds",
              });
              return {
                bucketName: bucket.bucketName,
                bucketArn: bucket.bucketArn,
                clusterArn: cluster.clusterArn,
                serviceName: service.serviceName,
                taskDefinitionArn: task.taskDefinitionArn,
              };
            }),
          );

          const notifications = yield* S3.getBucketNotificationConfiguration({
            Bucket: deployed.bucketName,
          });
          expect(notifications.QueueConfigurations).toHaveLength(1);
          const queueArn = notifications.QueueConfigurations![0]!.QueueArn;
          const queueName = queueArn.split(":").at(-1)!;
          const queue = yield* SQS.getQueueUrl({ QueueName: queueName });
          expect(queue.QueueUrl).toBeTruthy();
          queueUrl = queue.QueueUrl!;
        }),
        testOptions,
        stackName,
      ),
      { timeout: 120_000 },
    );

    afterAll(
      Core.withProviders(
        Effect.gen(function* () {
          yield* stack.destroy();
          if (deployed) {
            yield* S3.headBucket({ Bucket: deployed.bucketName }).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new FixtureResourceStillExists({ resource: "bucket" }),
                ),
              ),
              Effect.retry({
                while: (error) => error._tag === "FixtureResourceStillExists",
                schedule: Schedule.spaced("4 seconds"),
                times: 9,
              }),
              Effect.catchTag("NotFound", () => Effect.void),
              Effect.timeout("45 seconds"),
            );
            const clusters = yield* ECS.describeClusters({
              clusters: [deployed.clusterArn],
            });
            expect(
              (clusters.clusters ?? []).filter(
                (cluster) => cluster.status !== "INACTIVE",
              ),
            ).toEqual([]);
          }
          if (queueUrl) {
            yield* SQS.getQueueAttributes({
              QueueUrl: queueUrl,
              AttributeNames: ["QueueArn"],
            }).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new FixtureResourceStillExists({ resource: "queue" }),
                ),
              ),
              Effect.retry({
                while: (error) => error._tag === "FixtureResourceStillExists",
                schedule: Schedule.spaced("4 seconds"),
                times: 9,
              }),
              Effect.catchTag("QueueDoesNotExist", () => Effect.void),
              Effect.timeout("45 seconds"),
            );
          }
        }),
        testOptions,
        stackName,
      ),
      { timeout: 120_000 },
    );

    test.provider(
      "deploys an ECS consumer with an S3 principal and both notification filters",
      () =>
        Effect.gen(function* () {
          const fixture = deployed!;
          const result = yield* ECS.describeServices({
            cluster: fixture.clusterArn,
            services: [fixture.serviceName],
          });
          expect(result.failures ?? []).toEqual([]);
          expect(result.services).toHaveLength(1);
          const service = result.services![0]!;
          expect(service.taskDefinition).toBe(fixture.taskDefinitionArn);
          expect(service.runningCount).toBe(1);
          expect(service.pendingCount).toBe(0);
          expect(service.loadBalancers ?? []).toEqual([]);

          const notifications = yield* S3.getBucketNotificationConfiguration({
            Bucket: fixture.bucketName,
          });
          expect(notifications.QueueConfigurations).toHaveLength(1);
          expect(notifications.LambdaFunctionConfigurations ?? []).toEqual([]);
          const configuration = notifications.QueueConfigurations![0]!;
          expect(configuration.Events).toEqual([
            "s3:ObjectCreated:*",
            "s3:ObjectRemoved:*",
          ]);
          expect(configuration.Filter?.Key?.FilterRules).toEqual([
            { Name: "prefix", Value: INCOMING_PREFIX },
            { Name: "suffix", Value: INCOMING_SUFFIX },
          ]);

          const attributes = yield* SQS.getQueueAttributes({
            QueueUrl: queueUrl!,
            AttributeNames: ["Policy", "QueueArn"],
          });
          expect(attributes.Attributes?.QueueArn).toBe(configuration.QueueArn);
          const policy = yield* Effect.try(() =>
            JSON.parse(attributes.Attributes!.Policy!),
          );
          expect(policy).toEqual({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowS3EventsFromServerEventBucket",
                Effect: "Allow",
                Principal: { Service: "s3.amazonaws.com" },
                Action: ["sqs:SendMessage"],
                Resource: [configuration.QueueArn],
                Condition: {
                  ArnEquals: { "aws:SourceArn": fixture.bucketArn },
                },
              },
            ],
          });
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "records exact overwritten versions, delete markers, and version deletions through SQS",
      () =>
        Effect.gen(function* () {
          const Bucket = deployed!.bucketName;
          const key = `${INCOMING_PREFIX}space + percent% question? hash# 雪${INCOMING_SUFFIX}`;
          const outsidePrefix = `outside/ignored${INCOMING_SUFFIX}`;
          const outsideSuffix = `${INCOMING_PREFIX}ignored.bin`;
          const excluded = yield* Effect.all(
            [outsidePrefix, outsideSuffix].map((Key) =>
              S3.putObject({ Bucket, Key, Body: "not subscribed" }).pipe(
                Effect.map((result) => ({
                  key: Key,
                  versionId: result.VersionId!,
                })),
              ),
            ),
            { concurrency: 2 },
          );
          const first = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: "first version",
          });
          const second = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: "second version",
          });
          expect(first.VersionId).toBeTruthy();
          expect(second.VersionId).toBeTruthy();
          expect(first.VersionId).not.toBe(second.VersionId);

          const created = yield* waitForArtifacts([
            {
              key,
              eventName: "s3:ObjectCreated:Put",
              versionId: first.VersionId!,
            },
            {
              key,
              eventName: "s3:ObjectCreated:Put",
              versionId: second.VersionId!,
            },
          ]);
          expect(created.map((record) => record.content)).toEqual([
            "first version",
            "second version",
          ]);
          expect(created.map((record) => record.readVersionId)).toEqual([
            first.VersionId,
            second.VersionId,
          ]);
          expect(created[0]!.size).toBe("first version".length);
          expect(created[1]!.size).toBe("second version".length);
          expect(created.every((record) => !!record.eTag)).toBe(true);
          expect(created[0]!.sequencer).not.toBe(created[1]!.sequencer);

          const marker = yield* S3.deleteObject({ Bucket, Key: key });
          expect(marker.DeleteMarker).toBe(true);
          expect(marker.VersionId).toBeTruthy();
          const deleted = yield* S3.deleteObject({
            Bucket,
            Key: key,
            VersionId: first.VersionId!,
          });
          expect(deleted.VersionId).toBe(first.VersionId);
          const removed = yield* waitForArtifacts([
            {
              key,
              eventName: "s3:ObjectRemoved:DeleteMarkerCreated",
              versionId: marker.VersionId!,
            },
            {
              key,
              eventName: "s3:ObjectRemoved:Delete",
              versionId: first.VersionId!,
            },
          ]);
          expect(removed.every((record) => record.content === undefined)).toBe(
            true,
          );
          expect(
            removed.every((record) => record.readVersionId === undefined),
          ).toBe(true);

          const versions = yield* S3.listObjectVersions({
            Bucket,
            Prefix: key,
          });
          expect(
            (versions.Versions ?? []).map((version) => version.VersionId),
          ).toEqual([second.VersionId]);
          expect(versions.DeleteMarkers).toHaveLength(1);
          expect(versions.DeleteMarkers![0]!.VersionId).toBe(marker.VersionId);
          expect(versions.DeleteMarkers![0]!.IsLatest).toBe(true);

          for (const object of excluded) {
            const Key = yield* Effect.sync(() =>
              artifactKey(object.key, "s3:ObjectCreated:Put", object.versionId),
            );
            const exists = yield* S3.headObject({ Bucket, Key }).pipe(
              Effect.as(true),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
            );
            expect(exists).toBe(false);
          }
          const artifacts = yield* S3.listObjectsV2({
            Bucket,
            Prefix: PROCESSED_PREFIX,
          });
          expect(artifacts.IsTruncated).toBe(false);
          expect(artifacts.Contents).toHaveLength(4);
        }),
      { timeout: 120_000 },
    );
  });

interface NotificationIdentity {
  key: string;
  eventName: string;
  versionId: string;
}

const artifactSchema = Schema.Struct({
  bucket: Schema.String,
  key: Schema.String,
  eventName: Schema.String,
  versionId: Schema.String,
  sequencer: Schema.String,
  size: Schema.optional(Schema.Number),
  eTag: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  readVersionId: Schema.optional(Schema.String),
});

const readArtifact = Effect.fn(function* (identity: NotificationIdentity) {
  const Key = yield* Effect.sync(() =>
    artifactKey(identity.key, identity.eventName, identity.versionId),
  );
  const object = yield* S3.getObject({
    Bucket: deployed!.bucketName,
    Key,
  }).pipe(
    Effect.catchTag("NoSuchKey", () =>
      Effect.fail(new ArtifactNotReady(identity)),
    ),
    Effect.retry({
      while: (error) => error._tag === "ArtifactNotReady",
      schedule: Schedule.spaced("4 seconds"),
      times: 9,
    }),
  );
  const body = yield* Stream.mkString(Stream.decodeText(object.Body!));
  const record = yield* Effect.try(() => JSON.parse(body)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(artifactSchema)),
  );
  expect(record.bucket).toBe(deployed!.bucketName);
  expect(record.key).toBe(identity.key);
  expect(record.eventName).toBe(identity.eventName);
  expect(record.versionId).toBe(identity.versionId);
  expect(record.sequencer).toMatch(/^[0-9a-f]+$/i);
  return record;
});

const waitForArtifacts = (identities: NotificationIdentity[]) =>
  Effect.all(identities.map(readArtifact), { concurrency: 2 }).pipe(
    Effect.timeout("45 seconds"),
  );

class ArtifactNotReady extends Data.TaggedError(
  "ArtifactNotReady",
)<NotificationIdentity> {}

class FixtureResourceStillExists extends Data.TaggedError(
  "FixtureResourceStillExists",
)<{
  resource: string;
}> {}
