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

test(
  "create, update, delete table",
  Effect.gen(function* () {
    class TestTable extends Table("TestTable", {
      tableName: "test",
      items: type<{ id: string }>,
      attributes: {
        id: S.String,
      },
      partitionKey: "id",
    }) {}

    const stack = yield* apply(TestTable);

    const actualTable = yield* DynamoDB.describeTable({
      TableName: stack.TestTable.tableName,
    });
    expect(actualTable.Table?.TableArn).toEqual(stack.TestTable.tableArn);

    yield* destroy();

    yield* assertTableIsDeleted(stack.TestTable.tableName);
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
