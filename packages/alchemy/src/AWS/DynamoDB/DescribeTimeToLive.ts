import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DescribeTimeToLiveRequest extends Omit<
  DynamoDB.DescribeTimeToLiveInput,
  "TableName"
> {}

/** @binding */
export interface DescribeTimeToLive extends Binding.Service<
  DescribeTimeToLive,
  "AWS.DynamoDB.DescribeTimeToLive",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: DescribeTimeToLiveRequest,
    ) => Effect.Effect<
      DynamoDB.DescribeTimeToLiveOutput,
      DynamoDB.DescribeTimeToLiveError
    >
  >
> {}
export const DescribeTimeToLive = Binding.Service<DescribeTimeToLive>(
  "AWS.DynamoDB.DescribeTimeToLive",
);
