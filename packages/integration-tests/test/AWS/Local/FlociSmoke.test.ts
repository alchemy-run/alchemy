/**
 * Floci local-emulator smoke test.
 *
 * Deploys real AWS resources (S3 Bucket, SQS Queue, DynamoDB Table) through
 * the regular live providers, but pointed at a locally-running floci emulator
 * via the floci-scoped environment the local AWS providers carry.
 *
 * ## How local mode is activated
 *
 * The AWS auth method is normally chosen by the profile entry in
 * `~/.alchemy/profiles.json` (written by `alchemy profile edit`). Tests
 * must not depend on the developer's on-disk profiles. `Test.make({ dev:
 * true })` runs the stack the way `alchemy dev` does, so the local AWS
 * providers are selected; they carry their own floci-scoped environment,
 * which resolves dummy credentials (`test`/`test`), accountId
 * `000000000000`, and endpoint `http://localhost:4566`, and `ensureFloci()`
 * guarantees the emulator is serving (starting the `alchemy-floci`
 * container if needed). Without `dev: true` the live providers run against
 * whatever account the profile resolves — the real cloud.
 *
 * ## Why no real-AWS calls can happen
 *
 * The floci environment's credentials are hardcoded dummies and its accountId
 * is fixed — it never calls STS. Every SDK call carries the emulator endpoint
 * (via `Endpoint.fromEnvironment`); if any call ever escaped to real AWS it
 * would fail auth immediately (the dummy keys exist in no real account).
 *
 * Requires Docker (floci runs as a container); skipped when the Docker
 * daemon is unavailable.
 */
import * as AWS from "@alchemy.run/aws";
import { Table } from "@alchemy.run/aws/DynamoDB";
import { Bucket } from "@alchemy.run/aws/S3";
import { Queue } from "@alchemy.run/aws/SQS";
import { expect } from "@alchemy.run/test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { dockerAvailable, rawAwsJson, rawS3GetBucket, regionOfArn } from "./fixtures/raw.ts";

const providers = AWS.providers();

// `dev: true` runs the same topology as the real `alchemy dev` command
// (including the RPC sidecar default for RPC-backed providers).
const { test } = Test.make({ providers, dev: true });

test.provider.skipIf(!dockerAvailable)(
  "deploys S3 + SQS + DynamoDB into floci and destroys them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("FlociBucket");
          const queue = yield* Queue("FlociQueue");
          const table = yield* Table("FlociTable", {
            partitionKey: "id",
            attributes: { id: "S" },
          });
          return { bucket, queue, table };
        }),
      );

      // Attributes prove the providers ran their full reconcile loops. The
      // dummy-account ARNs double as proof no real AWS account was involved.
      expect(outputs.bucket.bucketName).toBeDefined();
      expect(outputs.bucket.bucketArn).toContain(outputs.bucket.bucketName);
      expect(outputs.queue.queueUrl).toContain(outputs.queue.queueName);
      expect(outputs.queue.queueArn).toContain(":000000000000:");
      expect(outputs.table.tableArn).toContain(":000000000000:");

      const region = regionOfArn(outputs.queue.queueArn);

      // --- Out-of-band verification: raw HTTP against the emulator gateway,
      // no distilled SDK, no alchemy layers. If the resources had gone to
      // real AWS these calls would not find them here.
      const listQueues = yield* rawAwsJson({
        service: "sqs",
        region,
        target: "AmazonSQS.ListQueues",
        contentType: "application/x-amz-json-1.0",
        body: {},
      });
      expect(listQueues.status).toBe(200);
      const queues = (yield* listQueues.json) as { QueueUrls?: string[] };
      expect(queues.QueueUrls?.some((url) => url.endsWith(`/${outputs.queue.queueName}`))).toBe(
        true,
      );

      const describeTable = yield* rawAwsJson({
        service: "dynamodb",
        region: regionOfArn(outputs.table.tableArn),
        target: "DynamoDB_20120810.DescribeTable",
        contentType: "application/x-amz-json-1.0",
        body: { TableName: outputs.table.tableName },
      });
      expect(describeTable.status).toBe(200);
      const described = (yield* describeTable.json) as {
        Table?: { TableArn?: string };
      };
      expect(described.Table?.TableArn).toBe(outputs.table.tableArn);

      const getBucket = yield* rawS3GetBucket(outputs.bucket.bucketName);
      expect(getBucket.status).toBe(200);

      // --- Destroy and verify gone from the emulator.
      yield* stack.destroy();

      const listQueuesAfter = yield* rawAwsJson({
        service: "sqs",
        region,
        target: "AmazonSQS.ListQueues",
        contentType: "application/x-amz-json-1.0",
        body: {},
      });
      const queuesAfter = (yield* listQueuesAfter.json) as {
        QueueUrls?: string[];
      };
      expect(
        queuesAfter.QueueUrls?.some((url) => url.endsWith(`/${outputs.queue.queueName}`)) ?? false,
      ).toBe(false);

      const describeTableAfter = yield* rawAwsJson({
        service: "dynamodb",
        region: regionOfArn(outputs.table.tableArn),
        target: "DynamoDB_20120810.DescribeTable",
        contentType: "application/x-amz-json-1.0",
        body: { TableName: outputs.table.tableName },
      });
      expect(describeTableAfter.status).toBe(400); // ResourceNotFoundException

      const getBucketAfter = yield* rawS3GetBucket(outputs.bucket.bucketName);
      expect(getBucketAfter.status).toBe(404); // NoSuchBucket
    }),
  {
    tags: ["provider:aws", "provider:aws:dynamodb", "provider:aws:s3", "provider:aws:sqs", "local"],
    timeout: 240_000,
  },
);
