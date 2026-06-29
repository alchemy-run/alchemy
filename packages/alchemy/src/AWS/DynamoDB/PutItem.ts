import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface PutItemRequest extends Omit<
  DynamoDB.PutItemInput,
  "TableName"
> {}

/** @binding */
export interface PutItem extends Binding.Service<
  PutItem,
  "AWS.DynamoDB.PutItem",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: PutItemRequest,
    ) => Effect.Effect<DynamoDB.PutItemOutput, DynamoDB.PutItemError>
  >
> {}

export const PutItem = Binding.Service<PutItem>("AWS.DynamoDB.PutItem");
