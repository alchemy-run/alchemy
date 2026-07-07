import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface ExecuteTransactionRequest
  extends DynamoDB.ExecuteTransactionInput {}

export type ExecuteTransactionTables = [Table, ...Table[]];

/** @binding */
export interface ExecuteTransaction extends Binding.Service<
  ExecuteTransaction,
  "AWS.DynamoDB.ExecuteTransaction",
  (
    ...tables: ExecuteTransactionTables
  ) => Effect.Effect<
    (
      request: ExecuteTransactionRequest,
    ) => Effect.Effect<
      DynamoDB.ExecuteTransactionOutput,
      DynamoDB.ExecuteTransactionError
    >
  >
> {}

export const ExecuteTransaction = Binding.Service<ExecuteTransaction>(
  "AWS.DynamoDB.ExecuteTransaction",
);
