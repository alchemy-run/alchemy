import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface UpdateTimeToLiveRequest extends Omit<
  DynamoDB.UpdateTimeToLiveInput,
  "TableName"
> {}

/** @binding */
export interface UpdateTimeToLive extends Binding.Service<
  UpdateTimeToLive,
  "AWS.DynamoDB.UpdateTimeToLive",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: UpdateTimeToLiveRequest,
    ) => Effect.Effect<
      DynamoDB.UpdateTimeToLiveOutput,
      DynamoDB.UpdateTimeToLiveError
    >
  >
> {}
export const UpdateTimeToLive = Binding.Service<UpdateTimeToLive>(
  "AWS.DynamoDB.UpdateTimeToLive",
);
