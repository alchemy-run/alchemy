import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DescribeTableRequest extends Omit<
  DynamoDB.DescribeTableInput,
  "TableName"
> {}

/** @binding */
export interface DescribeTable extends Binding.Service<
  DescribeTable,
  "AWS.DynamoDB.DescribeTable",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: DescribeTableRequest,
    ) => Effect.Effect<
      DynamoDB.DescribeTableOutput,
      DynamoDB.DescribeTableError
    >
  >
> {}

export const DescribeTable = Binding.Service<DescribeTable>(
  "AWS.DynamoDB.DescribeTable",
);
