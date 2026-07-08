import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface QueryRequest extends Omit<DynamoDB.QueryInput, "TableName"> {}

/** @binding */
export interface Query extends Binding.Service<
  Query,
  "AWS.DynamoDB.Query",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: QueryRequest,
    ) => Effect.Effect<DynamoDB.QueryOutput, DynamoDB.QueryError>
  >
> {}
export const Query = Binding.Service<Query>("AWS.DynamoDB.Query");
