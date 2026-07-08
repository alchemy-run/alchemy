import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListTablesRequest extends DynamoDB.ListTablesInput {}

/** @binding */
export interface ListTables extends Binding.Service<
  ListTables,
  "AWS.DynamoDB.ListTables",
  () => Effect.Effect<
    (
      request?: ListTablesRequest,
    ) => Effect.Effect<DynamoDB.ListTablesOutput, DynamoDB.ListTablesError>
  >
> {}

export const ListTables = Binding.Service<ListTables>(
  "AWS.DynamoDB.ListTables",
);
