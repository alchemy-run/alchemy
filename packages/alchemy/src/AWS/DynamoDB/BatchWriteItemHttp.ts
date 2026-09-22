import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BatchWriteItem,
  type BatchWriteItemRequest,
  type BatchWriteItemTables,
  sortBatchWriteItemTables,
} from "./BatchWriteItem.ts";
import { grantTables, signed, tablesRegion } from "./BindingHttp.ts";

export const BatchWriteItemHttp = Layer.effect(
  BatchWriteItem,
  Effect.gen(function* () {
    return Effect.fn(function* (...tables: BatchWriteItemTables) {
      const sortedTables = sortBatchWriteItemTables(tables);
      const tableNames = new Map(
        yield* Effect.forEach(sortedTables, (table) =>
          Effect.gen(function* () {
            return [table.LogicalId, yield* table.tableName] as const;
          }),
        ),
      );

      const getTableName = Effect.fn(function* (tableId: string) {
        const TableName = tableNames.get(tableId);
        if (!TableName) {
          return yield* Effect.die(
            new Error(
              `BatchWriteItem request references unbound table '${tableId}'`,
            ),
          );
        }
        return yield* TableName;
      });

      const access = yield* grantTables(
        `AWS.DynamoDB.BatchWriteItem(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
          {
            Effect: "Allow",
            Action: ["dynamodb:BatchWriteItem"],
            Resource: sortedTables.map((table) => table.tableArn),
          },
        ],
      );
      const region = yield* tablesRegion(access, sortedTables);

      return Effect.fn(`AWS.DynamoDB.BatchWriteItem(${sortedTables})`)(
        function* (request: BatchWriteItemRequest) {
          const requestItems = yield* Effect.forEach(
            Object.entries(request.RequestItems),
            ([tableId, writes]) =>
              Effect.gen(function* () {
                return [yield* getTableName(tableId), writes] as const;
              }),
          );

          return yield* signed(
            access,
            region,
            DynamoDB.batchWriteItem({
              ...request,
              RequestItems: Object.fromEntries(requestItems),
            }),
          );
        },
      );
    });
  }),
);
