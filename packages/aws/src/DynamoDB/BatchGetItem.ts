import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export type BatchGetItemTables = [Table, ...Table[]];

type BatchGetItemKeysAndAttributes = NonNullable<
  DynamoDB.BatchGetItemInput["RequestItems"]
>[string];

export interface BatchGetItemRequest extends Omit<DynamoDB.BatchGetItemInput, "RequestItems"> {
  RequestItems: Record<string, BatchGetItemKeysAndAttributes>;
}

/**
 * Runtime binding for `dynamodb:BatchGetItem`.
 *
 * Bind this operation to one or more tables and key the request by each bound
 * table's `LogicalId`. The binding resolves those logical IDs to physical table
 * names at runtime.
 * ### Reading Data
 * **Example:** Read Items Across Multiple Tables
 * ```typescript
 * const batchGetItem = yield* BatchGetItem(sourceTable, archiveTable);
 *
 * const response = yield* batchGetItem({
 *   RequestItems: {
 *     [sourceTable.LogicalId]: {
 *       Keys: [{ pk: { S: "user#1" }, sk: { S: "profile" } }],
 *     },
 *     [archiveTable.LogicalId]: {
 *       Keys: [{ pk: { S: "user#1" }, sk: { S: "profile" } }],
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface BatchGetItem extends Binding.Service<
  BatchGetItem,
  "AWS.DynamoDB.BatchGetItem",
  (
    ...tables: BatchGetItemTables
  ) => Effect.Effect<
    (
      request: BatchGetItemRequest,
    ) => Effect.Effect<DynamoDB.BatchGetItemOutput, DynamoDB.BatchGetItemError>
  >
> {}
export const BatchGetItem = Binding.Service<BatchGetItem>("AWS.DynamoDB.BatchGetItem");

export const BatchGetItemHttp = Layer.effect(
  BatchGetItem,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* (...tables: BatchGetItemTables) {
      const sortedTables = sortTables(tables);
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
            new Error(`BatchGetItem request references unbound table '${tableId}'`),
          );
        }
        return yield* TableName;
      });

      yield* grantTables(
        `AWS.DynamoDB.BatchGetItem(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
          {
            Effect: "Allow",
            Action: ["dynamodb:BatchGetItem"],
            Resource: sortedTables.map((table) => table.tableArn),
          },
        ],
      );
      const batchGetItem = yield* AWSBindings.withCredentials(
        DynamoDB.batchGetItem,
        tablesRegion(sortedTables),
      );

      return Effect.fn(
        `AWS.DynamoDB.BatchGetItem(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
      )(function* (request: BatchGetItemRequest) {
        const requestItems = yield* Effect.forEach(
          Object.entries(request.RequestItems),
          ([tableId, keys]) =>
            Effect.gen(function* () {
              return [yield* getTableName(tableId), keys] as const;
            }),
        );

        return yield* batchGetItem({
          ...request,
          RequestItems: Object.fromEntries(requestItems),
        });
      });
    });
  }),
);

const sortTables = (tables: BatchGetItemTables) =>
  [...new Map(tables.map((table) => [table.LogicalId, table] as const)).values()].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as BatchGetItemTables;
