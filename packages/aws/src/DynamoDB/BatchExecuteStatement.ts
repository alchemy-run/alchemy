import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export type BatchExecuteStatementTables = [Table, ...Table[]];

export const sortBatchExecuteStatementTables = (tables: BatchExecuteStatementTables) =>
  [...new Map(tables.map((table) => [table.LogicalId, table] as const)).values()].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as BatchExecuteStatementTables;

export interface BatchExecuteStatementRequest extends DynamoDB.BatchExecuteStatementInput {}

/**
 * Runtime binding for DynamoDB PartiQL `BatchExecuteStatement`.
 *
 * The request is passed through unchanged, but IAM is scoped to the explicitly
 * bound tables and their indexes.
 * ### PartiQL
 * **Example:** Execute a Batch of Statements
 * ```typescript
 * const batchExecuteStatement = yield* AWS.DynamoDB.BatchExecuteStatement(
 *   sourceTable,
 *   archiveTable,
 * );
 *
 * const response = yield* batchExecuteStatement({
 *   Statements: [
 *     {
 *       Statement: `SELECT * FROM "${yield* sourceTable.tableName}" WHERE pk=?`,
 *       Parameters: [{ S: "user#1" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface BatchExecuteStatement extends Binding.Service<
  BatchExecuteStatement,
  "AWS.DynamoDB.BatchExecuteStatement",
  (
    ...tables: BatchExecuteStatementTables
  ) => Effect.Effect<
    (
      request: BatchExecuteStatementRequest,
    ) => Effect.Effect<DynamoDB.BatchExecuteStatementOutput, DynamoDB.BatchExecuteStatementError>
  >
> {}

export const BatchExecuteStatement = Binding.Service<BatchExecuteStatement>(
  "AWS.DynamoDB.BatchExecuteStatement",
);

export const BatchExecuteStatementHttp = Layer.effect(
  BatchExecuteStatement,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* (...tables: BatchExecuteStatementTables) {
      const sortedTables = sortBatchExecuteStatementTables(tables);
      yield* grantTables(
        `AWS.DynamoDB.BatchExecuteStatement(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
          {
            Effect: "Allow",
            Action: [
              "dynamodb:PartiQLDelete",
              "dynamodb:PartiQLInsert",
              "dynamodb:PartiQLSelect",
              "dynamodb:PartiQLUpdate",
            ],
            Resource: sortedTables.flatMap((table) => [
              table.tableArn,
              Output.interpolate`${table.tableArn}/index/*`,
            ]),
          },
        ],
      );
      const batchExecuteStatement = yield* AWSBindings.withCredentials(
        DynamoDB.batchExecuteStatement,
        tablesRegion(sortedTables),
      );
      return Effect.fn(
        `AWS.DynamoDB.BatchExecuteStatement(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
      )(function* (request: BatchExecuteStatementRequest) {
        return yield* batchExecuteStatement(request);
      });
    });
  }),
);
