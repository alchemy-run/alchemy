import { $ } from "@/index";
import * as AWS from "@/aws";
import { Table } from "@/aws/dynamodb";
import * as Lambda from "@/aws/lambda";
import { apply, destroy, type } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as DynamoDB from "distilled-aws/dynamodb";
import * as lambdaApi from "distilled-aws/lambda";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "..", "..", "handler.ts");

// Helper to find event source mapping with retry for eventual consistency
class EventSourceMappingNotFound extends Data.TaggedError(
  "EventSourceMappingNotFound",
) {}

const findEventSourceMapping = (functionName: string) =>
  Effect.gen(function* () {
    const mappings = yield* lambdaApi.listEventSourceMappings({
      FunctionName: functionName,
    });
    const mapping = mappings.EventSourceMappings?.find((esm) =>
      esm.EventSourceArn?.includes("/stream/"),
    );
    if (!mapping) {
      return yield* Effect.fail(new EventSourceMappingNotFound());
    }
    return mapping;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "EventSourceMappingNotFound",
      schedule: Schedule.exponential(500).pipe(
        Schedule.intersect(Schedule.recurs(10)),
      ),
    }),
  );

test(
  "create table consumer with consumeTable",
  Effect.gen(function* () {
    class TestTable extends Table("TestTable", {
      items: type<{ id: string; name: string }>,
      attributes: { id: S.String },
      partitionKey: "id",
    }) {}

    class TableConsumer extends Lambda.consumeTable("TableConsumer", {
      table: TestTable,
      handle: Effect.fn(function* (event) {
        for (const record of event.Records) {
          console.log("Event:", record.eventName);
          console.log("New:", record.dynamodb?.NewImage);
          console.log("Old:", record.dynamodb?.OldImage);
        }
      }),
    })({
      main,
      bindings: $(),
    }) {}

    const stack = yield* apply(TestTable, TableConsumer);

    // Verify the table exists
    const tableDescription = yield* DynamoDB.describeTable({
      TableName: stack.TestTable.tableName,
    });
    expect(tableDescription.Table?.TableArn).toEqual(stack.TestTable.tableArn);

    // Verify streams are enabled on the table
    expect(tableDescription.Table?.StreamSpecification?.StreamEnabled).toBe(
      true,
    );
    expect(tableDescription.Table?.StreamSpecification?.StreamViewType).toBe(
      "NEW_AND_OLD_IMAGES",
    );

    // Verify the Lambda function exists
    const functionInfo = yield* lambdaApi.getFunction({
      FunctionName: stack.TableConsumer.functionName,
    });
    expect(functionInfo.Configuration?.FunctionArn).toBeDefined();

    // Verify event source mapping exists (with retry for eventual consistency)
    const tableMapping = yield* findEventSourceMapping(
      stack.TableConsumer.functionName,
    );
    expect(tableMapping).toBeDefined();
    expect(tableMapping?.State).toBe("Enabled");

    yield* destroy();

    yield* assertTableIsDeleted(stack.TestTable.tableName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "consumeTable with custom stream view type",
  Effect.gen(function* () {
    class KeysOnlyTable extends Table("KeysOnlyTable", {
      items: type<{ id: string }>,
      attributes: { id: S.String },
      partitionKey: "id",
    }) {}

    class KeysOnlyConsumer extends Lambda.consumeTable("KeysOnlyConsumer", {
      table: KeysOnlyTable,
      streamViewType: "KEYS_ONLY",
      handle: Effect.fn(function* (event) {
        for (const record of event.Records) {
          console.log("Keys:", record.dynamodb?.Keys);
        }
      }),
    })({
      main,
      bindings: $(),
    }) {}

    const stack = yield* apply(KeysOnlyTable, KeysOnlyConsumer);

    // Verify the stream view type
    const tableDescription = yield* DynamoDB.describeTable({
      TableName: stack.KeysOnlyTable.tableName,
    });
    expect(tableDescription.Table?.StreamSpecification?.StreamViewType).toBe(
      "KEYS_ONLY",
    );

    yield* destroy();

    yield* assertTableIsDeleted(stack.KeysOnlyTable.tableName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "consumeTable with batch settings",
  Effect.gen(function* () {
    class BatchTable extends Table("BatchTable", {
      items: type<{ id: string }>,
      attributes: { id: S.String },
      partitionKey: "id",
    }) {}

    class BatchConsumer extends Lambda.consumeTable("BatchConsumer", {
      table: BatchTable,
      batchSize: 50,
      maxBatchingWindow: 10,
      parallelizationFactor: 2,
      handle: Effect.fn(function* (event) {
        console.log("Batch size:", event.Records.length);
      }),
    })({
      main,
      bindings: $(),
    }) {}

    const stack = yield* apply(BatchTable, BatchConsumer);

    // Verify event source mapping has correct settings (with retry for eventual consistency)
    const mapping = yield* findEventSourceMapping(
      stack.BatchConsumer.functionName,
    );
    expect(mapping?.BatchSize).toBe(50);
    expect(mapping?.MaximumBatchingWindowInSeconds).toBe(10);
    expect(mapping?.ParallelizationFactor).toBe(2);

    yield* destroy();

    yield* assertTableIsDeleted(stack.BatchTable.tableName);
  }).pipe(Effect.provide(AWS.providers())),
);

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
