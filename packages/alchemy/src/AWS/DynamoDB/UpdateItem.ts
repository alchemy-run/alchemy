import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface UpdateItemRequest extends Omit<
  DynamoDB.UpdateItemInput,
  "TableName"
> {}

/** @binding */
export interface UpdateItem extends Binding.Service<
  UpdateItem,
  "AWS.DynamoDB.UpdateItem",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: UpdateItemRequest,
    ) => Effect.Effect<DynamoDB.UpdateItemOutput, DynamoDB.UpdateItemError>
  >
> {}
export const UpdateItem = Binding.Service<UpdateItem>(
  "AWS.DynamoDB.UpdateItem",
);
