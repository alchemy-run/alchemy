import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTableIamHttpBinding } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export interface ExecuteStatementRequest extends DynamoDB.ExecuteStatementInput {}

/**
 * Runtime binding for DynamoDB PartiQL `ExecuteStatement`.
 *
 * This binding scopes IAM to a specific table, but the statement text is still
 * user-provided. Statements must only reference the bound table or its indexes.
 * ### PartiQL
 * **Example:** Execute a Statement Against One Table
 * ```typescript
 * const executeStatement = yield* AWS.DynamoDB.ExecuteStatement(table);
 *
 * const response = yield* executeStatement({
 *   Statement: `SELECT * FROM "${yield* table.tableName}" WHERE pk=?`,
 *   Parameters: [{ S: "user#1" }],
 * });
 * ```
 *
 * @binding
 */
export interface ExecuteStatement extends Binding.Service<
  ExecuteStatement,
  "AWS.DynamoDB.ExecuteStatement",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: ExecuteStatementRequest,
    ) => Effect.Effect<DynamoDB.ExecuteStatementOutput, DynamoDB.ExecuteStatementError>
  >
> {}

export const ExecuteStatement = Binding.Service<ExecuteStatement>("AWS.DynamoDB.ExecuteStatement");

export const ExecuteStatementHttp = Layer.effect(
  ExecuteStatement,
  makeTableIamHttpBinding({
    tag: "AWS.DynamoDB.ExecuteStatement",
    operation: DynamoDB.executeStatement,
    actions: [
      "dynamodb:PartiQLDelete",
      "dynamodb:PartiQLInsert",
      "dynamodb:PartiQLSelect",
      "dynamodb:PartiQLUpdate",
    ],
    resources: (table) => [table.tableArn, Output.interpolate`${table.tableArn}/index/*`],
  }),
);
