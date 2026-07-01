import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface ListTagsOfResourceRequest extends Omit<
  DynamoDB.ListTagsOfResourceInput,
  "ResourceArn"
> {}

/** @binding */
export interface ListTagsOfResource extends Binding.Service<
  ListTagsOfResource,
  "AWS.DynamoDB.ListTagsOfResource",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: ListTagsOfResourceRequest,
    ) => Effect.Effect<
      DynamoDB.ListTagsOfResourceOutput,
      DynamoDB.ListTagsOfResourceError
    >
  >
> {}

export const ListTagsOfResource = Binding.Service<ListTagsOfResource>(
  "AWS.DynamoDB.ListTagsOfResource",
);
