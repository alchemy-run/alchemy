import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export interface ExecuteTransactionRequest extends DynamoDB.ExecuteTransactionInput {}

export type ExecuteTransactionTables = [Table, ...Table[]];

/**
 * Runtime binding for `dynamodb:ExecuteTransaction`.
 *
 * Bind this operation to one or more tables inside a function runtime to get a
 * callable that runs a PartiQL transaction. Statements reference the bound
 * tables by their physical names (resolve them via `table.tableName`); the
 * host is granted the transactional read/write actions on every bound table.
 * Provide the `ExecuteTransactionHttp` layer on the Function to satisfy the
 * binding.
 * ### PartiQL
 * **Example:** Run a PartiQL Transaction
 * ```typescript
 * const executeTransaction = yield* AWS.DynamoDB.ExecuteTransaction(table);
 * const tableName = yield* table.tableName;
 *
 * yield* executeTransaction({
 *   TransactStatements: [
 *     {
 *       Statement: `UPDATE "${tableName}" SET balance = balance - 10 WHERE pk = ? AND sk = ?`,
 *       Parameters: [{ S: "account#1" }, { S: "balance" }],
 *     },
 *     {
 *       Statement: `UPDATE "${tableName}" SET balance = balance + 10 WHERE pk = ? AND sk = ?`,
 *       Parameters: [{ S: "account#2" }, { S: "balance" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface ExecuteTransaction extends Binding.Service<
  ExecuteTransaction,
  "AWS.DynamoDB.ExecuteTransaction",
  (
    ...tables: ExecuteTransactionTables
  ) => Effect.Effect<
    (
      request: ExecuteTransactionRequest,
    ) => Effect.Effect<DynamoDB.ExecuteTransactionOutput, DynamoDB.ExecuteTransactionError>
  >
> {}

export const ExecuteTransaction = Binding.Service<ExecuteTransaction>(
  "AWS.DynamoDB.ExecuteTransaction",
);

export const ExecuteTransactionHttp = Layer.effect(
  ExecuteTransaction,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* (...tables: ExecuteTransactionTables) {
      const sortedTables = [...tables].sort((a, b) => a.LogicalId.localeCompare(b.LogicalId));
      yield* grantTables(
        `AWS.DynamoDB.ExecuteTransaction(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
          {
            Effect: "Allow",
            Action: [
              "dynamodb:PartiQLSelect",
              "dynamodb:PartiQLInsert",
              "dynamodb:PartiQLUpdate",
              "dynamodb:PartiQLDelete",
            ],
            Resource: sortedTables.map((table) => table.tableArn),
          },
        ],
      );
      const executeTransaction = yield* AWSBindings.withCredentials(
        DynamoDB.executeTransaction,
        tablesRegion(sortedTables),
      );
      return Effect.fn(
        `AWS.DynamoDB.ExecuteTransaction(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
      )(function* (request: ExecuteTransactionRequest) {
        return yield* executeTransaction(request);
      });
    });
  }),
);
