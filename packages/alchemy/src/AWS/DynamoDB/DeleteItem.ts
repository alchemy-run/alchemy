import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DeleteItemRequest extends Omit<
  DynamoDB.DeleteItemInput,
  "TableName"
> {}

/** @binding */
export interface DeleteItem extends Binding.Service<
  DeleteItem,
  "AWS.DynamoDB.DeleteItem",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: DeleteItemRequest,
    ) => Effect.Effect<DynamoDB.DeleteItemOutput, DynamoDB.DeleteItemError>
  >
> {}

export const DeleteItem = Binding.Service<DeleteItem>(
  "AWS.DynamoDB.DeleteItem",
);
