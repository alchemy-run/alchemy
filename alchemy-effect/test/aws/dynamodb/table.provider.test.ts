import * as AWS from "@/aws";
import * as DynamoDB from "@/aws/dynamodb";
import { apply, destroy, type } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import { LogLevel } from "effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

test(
  "create, update, delete table",
  Effect.gen(function* () {
    const dynamodb = yield* DynamoDB.DynamoDBClient;

    let stack;
    {
      class Table extends DynamoDB.Table("Table", {
        tableName: "test",
        items: type<{ id: string }>,
        attributes: {
          id: S.String,
        },
        partitionKey: "id",
      }) {}

      stack = yield* apply(Table);

      const actualTable = yield* dynamodb.describeTable({
        TableName: stack.Table.tableName,
      });
      expect(actualTable.Table?.TableArn).toEqual(stack.Table.tableArn);
    }

    yield* destroy();

    yield* waitForTableToBeDeleted(stack.Table.tableName);
  }).pipe(Effect.provide(AWS.live), Logger.withMinimumLogLevel(LogLevel.Info)),
);

const waitForTableToBeDeleted = Effect.fn(function* (tableName: string) {
  const dynamodb = yield* DynamoDB.DynamoDBClient;
  dynamodb
    .describeTable({
      TableName: tableName,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new TableStillExists())),
      Effect.retry({
        while: (e) => e._tag === "TableStillExists",
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
});

class TableStillExists extends Data.TaggedError("TableStillExists") {}
