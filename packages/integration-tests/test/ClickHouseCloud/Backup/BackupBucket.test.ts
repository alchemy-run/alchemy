import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as backup from "@distilled.cloud/clickhouse-cloud/backup";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { messageOf } from "../fixtures/errors.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// ClickHouse stores a bucket without reaching it, so buckets and credentials
// nobody owns prove the lifecycle without a cloud account. Backups taken
// while the test runs would fail; it lasts seconds.
const AWS_BUCKET = "https://alchemy-no-such-bucket-000000.s3.amazonaws.com";
const GCP_BUCKET = "https://storage.googleapis.com/alchemy-no-such-bucket-000000";

const getBucket = (serviceId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* backup
      .getBackupBucket({ organizationId, serviceId })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  });

const aws = (prefix: string, role = "alchemy-no-such-role") =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.Backup.BackupBucket("Bucket", {
      serviceId,
      bucketProvider: "AWS",
      bucketPath: `${AWS_BUCKET}/${prefix}`,
      iamRoleArn: `arn:aws:iam::000000000000:role/${role}`,
    });
  });

test.provider.skipIf(needsService)(
  "point backups at an S3 bucket, change its prefix and role in place, remove it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const first = yield* stack.deploy(aws("first"));
      expect(first.bucketProvider).toEqual("AWS");
      expect(yield* getBucket(first.serviceId)).toMatchObject({
        bucketPath: `${AWS_BUCKET}/first`,
      });

      const moved = yield* stack.deploy(aws("second", "alchemy-other-role"));
      expect(moved.bucketId).toEqual(first.bucketId);
      expect(moved.iamRoleArn).toEqual("arn:aws:iam::000000000000:role/alchemy-other-role");
      expect(yield* getBucket(first.serviceId)).toMatchObject({
        bucketPath: `${AWS_BUCKET}/second`,
      });

      yield* stack.destroy();
      expect(yield* getBucket(first.serviceId)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 300_000 },
);

test.provider.skipIf(needsService)(
  "a bucket in another cloud than the service is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const serviceId = yield* testServiceId;
      const error = yield* stack
        .deploy(
          ClickHouseCloud.Backup.BackupBucket("Bucket", {
            serviceId,
            bucketProvider: "GCP",
            bucketPath: `${GCP_BUCKET}/analytics`,
            accessKeyId: "GOOGALCHEMYNOSUCHKEY000000",
            secretAccessKey: Redacted.make("alchemy-no-such-secret"),
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("BadRequest");
      expect(messageOf(error)).toEqual(
        "BAD_REQUEST: Bucket provider must be the same as the service cloud provider",
      );
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
