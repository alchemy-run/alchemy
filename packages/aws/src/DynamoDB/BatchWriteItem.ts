import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export type BatchWriteItemTables = [Table, ...Table[]];

type BatchWriteRequests = NonNullable<DynamoDB.BatchWriteItemInput["RequestItems"]>[string];

export const sortBatchWriteItemTables = (tables: BatchWriteItemTables) =>
  [...new Map(tables.map((table) => [table.LogicalId, table] as const)).values()].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as BatchWriteItemTables;

export interface BatchWriteItemRequest extends Omit<DynamoDB.BatchWriteItemInput, "RequestItems"> {
  RequestItems: Record<string, BatchWriteRequests>;
}

/**
 * Runtime binding for `dynamodb:BatchWriteItem`.
 *
 * Bind this operation to one or more tables and key the request by each bound
 * table's `LogicalId`.
 * ### Writing Data
 * **Example:** Write Items Across Multiple Tables
 * ```typescript
 * const batchWriteItem = yield* AWS.DynamoDB.BatchWriteItem(sourceTable, archiveTable);
 *
 * const response = yield* batchWriteItem({
 *   RequestItems: {
 *     [sourceTable.LogicalId]: [
 *       {
 *         PutRequest: {
 *           Item: {
 *             pk: { S: "user#1" },
 *             sk: { S: "profile" },
 *           },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface BatchWriteItem extends Binding.Service<
  BatchWriteItem,
  "AWS.DynamoDB.BatchWriteItem",
  (
    ...tables: BatchWriteItemTables
  ) => Effect.Effect<
    (
      request: BatchWriteItemRequest,
    ) => Effect.Effect<DynamoDB.BatchWriteItemOutput, DynamoDB.BatchWriteItemError>
  >
> {}

export const BatchWriteItem = Binding.Service<BatchWriteItem>("AWS.DynamoDB.BatchWriteItem");

export const BatchWriteItemHttp = Layer.effect(
  BatchWriteItem,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
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
            new Error(`BatchWriteItem request references unbound table '${tableId}'`),
          );
        }
        return yield* TableName;
      });

      yield* grantTables(
        `AWS.DynamoDB.BatchWriteItem(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
          {
            Effect: "Allow",
            Action: ["dynamodb:BatchWriteItem"],
            Resource: sortedTables.map((table) => table.tableArn),
          },
        ],
      );
      const batchWriteItem = yield* AWSBindings.withCredentials(
        DynamoDB.batchWriteItem,
        tablesRegion(sortedTables),
      );

      return Effect.fn(
        `AWS.DynamoDB.BatchWriteItem(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
      )(function* (request: BatchWriteItemRequest) {
        const requestItems = yield* Effect.forEach(
          Object.entries(request.RequestItems),
          ([tableId, writes]) =>
            Effect.gen(function* () {
              return [yield* getTableName(tableId), writes] as const;
            }),
        );

        return yield* batchWriteItem({
          ...request,
          RequestItems: Object.fromEntries(requestItems),
        });
      });
    });
  }),
);
