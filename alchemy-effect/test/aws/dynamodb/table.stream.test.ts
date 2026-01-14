import { apply, destroy, type } from "@/index";

import * as AWS from "@/aws";
import { Table } from "@/aws/dynamodb";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as DynamoDB from "distilled-aws/dynamodb";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

// Retry policy for transient AWS errors
const retryTransient = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.retry({
      while: (e: unknown) => {
        const error = e as { name?: string; _tag?: string };
        return (
          error.name === "ResourceInUseException" ||
          error.name === "ThrottlingException" ||
          error._tag === "ThrottlingException" ||
          error._tag === "LimitExceededException"
        );
      },
      schedule: Schedule.exponential(500).pipe(
        Schedule.intersect(Schedule.recurs(10)),
      ),
    }),
  );

/**
 * This test validates our assumption that AWS UpdateTable without StreamSpecification
 * preserves existing stream configuration.
 *
 * This is important because:
 * 1. TableEventSource enables streams on a table in postattach
 * 2. If the Table resource is later updated, we need to ensure
 *    the Table provider doesn't accidentally disable the stream
 *
 * This test uses direct AWS API calls to verify the behavior,
 * bypassing the Table resource entirely.
 */
test(
  "table update preserves stream configuration",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const tableName = `alchemy-stream-test-${Date.now()}`;

    // Cleanup any existing table first
    yield* DynamoDB.deleteTable({ TableName: tableName }).pipe(
      Effect.catchAll(() => Effect.void),
    );
    yield* Effect.sleep(2000);

    // Create table directly via AWS API
    yield* DynamoDB.createTable({
      TableName: tableName,
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      BillingMode: "PAY_PER_REQUEST",
    }).pipe(retryTransient);

    yield* waitForTableActive(tableName);

    // Enable stream via updateTable
    yield* DynamoDB.updateTable({
      TableName: tableName,
      StreamSpecification: {
        StreamEnabled: true,
        StreamViewType: "NEW_AND_OLD_IMAGES",
      },
    }).pipe(retryTransient);

    yield* waitForTableActive(tableName);

    // Verify stream is enabled
    const descriptionAfterEnable = yield* DynamoDB.describeTable({
      TableName: tableName,
    }).pipe(retryTransient);
    expect(
      descriptionAfterEnable.Table?.StreamSpecification?.StreamEnabled,
    ).toBe(true);
    expect(
      descriptionAfterEnable.Table?.StreamSpecification?.StreamViewType,
    ).toBe("NEW_AND_OLD_IMAGES");
    expect(descriptionAfterEnable.Table?.LatestStreamArn).toBeDefined();

    // Update table without StreamSpecification - this is what we want to verify
    yield* DynamoDB.updateTable({
      TableName: tableName,
      DeletionProtectionEnabled: true,
    }).pipe(retryTransient);

    yield* waitForTableActive(tableName);

    // Verify stream is STILL enabled after update
    const descriptionAfterUpdate = yield* DynamoDB.describeTable({
      TableName: tableName,
    }).pipe(retryTransient);
    expect(
      descriptionAfterUpdate.Table?.StreamSpecification?.StreamEnabled,
    ).toBe(true);
    expect(
      descriptionAfterUpdate.Table?.StreamSpecification?.StreamViewType,
    ).toBe("NEW_AND_OLD_IMAGES");

    // Cleanup: Disable deletion protection and delete table
    yield* DynamoDB.updateTable({
      TableName: tableName,
      DeletionProtectionEnabled: false,
    }).pipe(retryTransient);

    yield* waitForTableActive(tableName);

    yield* DynamoDB.deleteTable({ TableName: tableName }).pipe(
      retryTransient,
      Effect.catchAll(() => Effect.void),
    );

    yield* assertTableIsDeleted(tableName);
  }).pipe(Effect.provide(AWS.providers())),
);

const waitForTableActive = Effect.fn(function* (tableName: string) {
  while (true) {
    const description = yield* DynamoDB.describeTable({
      TableName: tableName,
    }).pipe(retryTransient);
    if (description.Table?.TableStatus === "ACTIVE") {
      return description;
    }
    yield* Effect.sleep(1000);
  }
});

class TableStillExists extends Data.TaggedError("TableStillExists") {}

const assertTableIsDeleted = Effect.fn(function* (tableName: string) {
  yield* DynamoDB.describeTable({
    TableName: tableName,
  }).pipe(
    Effect.flatMap(() => Effect.fail(new TableStillExists())),
    Effect.retry({
      while: (e) => e._tag === "TableStillExists",
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});
