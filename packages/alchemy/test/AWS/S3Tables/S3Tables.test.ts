import * as AWS from "@/AWS";
import { Namespace, Table, TableBucket } from "@/AWS/S3Tables";
import * as Test from "@/Test/Vitest";
import * as s3tables from "@distilled.cloud/aws/s3tables";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Poll a getter until it reports the resource is gone (typed
// NotFoundException), bounded so a stuck delete fails fast.
const waitUntilGone = <A, E extends { _tag: string }, R>(
  read: Effect.Effect<A, E, R>,
) =>
  read.pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "StillExists" as const } as const),
    ),
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "StillExists",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
    Effect.catchIf(
      (e): e is E & { _tag: "NotFoundException" } =>
        e._tag === "NotFoundException",
      () => Effect.void,
    ),
  );

test.provider(
  "table bucket → namespace → table lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { bucket, namespace, table } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* TableBucket("Analytics");
          const namespace = yield* Namespace("Events", {
            tableBucket: bucket.tableBucketArn,
          });
          const table = yield* Table("PageViews", {
            tableBucket: bucket.tableBucketArn,
            namespace: namespace.namespace,
            schema: {
              fields: [
                { name: "id", type: "long", required: true },
                { name: "url", type: "string" },
                { name: "ts", type: "timestamp" },
              ],
            },
          });
          return { bucket, namespace, table };
        }),
      );

      expect(bucket.tableBucketArn).toContain(":bucket/");
      expect(bucket.ownerAccountId).toBeDefined();
      expect(table.tableArn).toContain("/table/");
      expect(table.format).toBe("ICEBERG");
      expect(table.warehouseLocation).toBeDefined();

      // Out-of-band verification via distilled.
      const observedBucket = yield* s3tables.getTableBucket({
        tableBucketARN: bucket.tableBucketArn,
      });
      expect(observedBucket.name).toBe(bucket.name);

      const observedNs = yield* s3tables.getNamespace({
        tableBucketARN: bucket.tableBucketArn,
        namespace: namespace.namespace,
      });
      expect(observedNs.namespace[0]).toBe(namespace.namespace);

      const observedTable = yield* s3tables.getTable({
        tableBucketARN: bucket.tableBucketArn,
        namespace: namespace.namespace,
        name: table.name,
      });
      expect(observedTable.tableARN).toBe(table.tableArn);

      // Idempotent re-deploy: reconciler observes existing cloud state and
      // converges without error.
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* TableBucket("Analytics");
          const namespace = yield* Namespace("Events", {
            tableBucket: bucket.tableBucketArn,
          });
          yield* Table("PageViews", {
            tableBucket: bucket.tableBucketArn,
            namespace: namespace.namespace,
            schema: {
              fields: [
                { name: "id", type: "long", required: true },
                { name: "url", type: "string" },
                { name: "ts", type: "timestamp" },
              ],
            },
          });
          return { bucket };
        }),
      );

      yield* stack.destroy();

      // The bucket (and everything under it) must be gone.
      yield* waitUntilGone(
        s3tables.getTableBucket({ tableBucketARN: bucket.tableBucketArn }),
      );
    }),
  { timeout: 180_000 },
);

test.provider(
  "table bucket replaces on name change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TableBucket("Renamed", {
            name: "alchemy-s3t-name-a",
          });
        }),
      );
      expect(first.name).toBe("alchemy-s3t-name-a");
      yield* s3tables.getTableBucket({ tableBucketARN: first.tableBucketArn });

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TableBucket("Renamed", {
            name: "alchemy-s3t-name-b",
          });
        }),
      );
      expect(second.name).toBe("alchemy-s3t-name-b");
      expect(second.tableBucketArn).not.toBe(first.tableBucketArn);

      // The old bucket must have been deleted as part of the replacement.
      yield* waitUntilGone(
        s3tables.getTableBucket({ tableBucketARN: first.tableBucketArn }),
      );

      yield* stack.destroy();
      yield* waitUntilGone(
        s3tables.getTableBucket({ tableBucketARN: second.tableBucketArn }),
      );
    }),
  { timeout: 180_000 },
);
