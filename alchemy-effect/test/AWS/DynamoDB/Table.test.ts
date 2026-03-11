import * as AWS from "@/AWS";
import { Table } from "@/AWS/DynamoDB";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as DynamoDB from "distilled-aws/dynamodb";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

test(
  "create, update, delete table",
  Effect.gen(function* () {
    const table = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Table("TestTable", {
          tableName: "test",
          partitionKey: "id",
          attributes: { id: "S" },
        });
      }),
    );

    const actualTable = yield* DynamoDB.describeTable({
      TableName: table.tableName,
    });
    expect(actualTable.Table?.TableArn).toEqual(table.tableArn);

    yield* destroy();

    yield* assertTableIsDeleted(table.tableName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create and update table stream configuration",
  Effect.gen(function* () {
    const table = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Table("StreamTable", {
          tableName: "test-stream-table-v2",
          partitionKey: "id",
          attributes: { id: "S" },
          streamSpecification: {
            StreamEnabled: true,
            StreamViewType: "NEW_AND_OLD_IMAGES",
          },
        });
      }),
    );

    const created = yield* DynamoDB.describeTable({
      TableName: table.tableName,
    });
    expect(created.Table?.StreamSpecification).toEqual({
      StreamEnabled: true,
      StreamViewType: "NEW_AND_OLD_IMAGES",
    });
    expect(created.Table?.LatestStreamArn).toBeDefined();

    yield* test.deploy(
      Effect.gen(function* () {
        return yield* Table("StreamTable", {
          tableName: "test-stream-table-v2",
          partitionKey: "id",
          attributes: { id: "S" },
          streamSpecification: {
            StreamEnabled: true,
            StreamViewType: "KEYS_ONLY",
          },
        });
      }),
    );

    const updated = yield* Effect.gen(function* () {
      const current = yield* DynamoDB.describeTable({
        TableName: table.tableName,
      });
      if (current.Table?.StreamSpecification?.StreamViewType !== "KEYS_ONLY") {
        return yield* Effect.fail(new StreamSpecNotUpdated());
      }
      return current;
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "StreamSpecNotUpdated",
        schedule: Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(10)),
        ),
      }),
    );
    expect(updated.Table?.StreamSpecification).toEqual({
      StreamEnabled: true,
      StreamViewType: "KEYS_ONLY",
    });

    yield* destroy();

    yield* assertTableIsDeleted(table.tableName);
  }).pipe(Effect.provide(AWS.providers())),
);

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

class TableStillExists extends Data.TaggedError("TableStillExists") {}

class StreamSpecNotUpdated extends Data.TaggedError("StreamSpecNotUpdated") {}
