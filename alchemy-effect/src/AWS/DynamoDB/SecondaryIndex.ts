import * as S from "effect/Schema";
import { Resource } from "../../Resource.ts";
import type { Table } from "./Table.ts";

export interface SecondaryIndexProps<
  Source extends Table = Table,
  Attributes extends S.Struct.Fields = S.Struct.Fields,
  PartitionKey extends keyof Attributes = keyof Attributes,
  SortKey extends keyof Attributes | undefined = keyof Attributes | undefined,
> {
  table: new () => Source;
  indexName?: string;
  partitionKey: PartitionKey;
  sortKey?: SortKey;
}

export interface SecondaryIndex extends Resource<
  "AWS.DynamoDB.SecondaryIndex",
  SecondaryIndexProps,
  {
    indexName: string;
  }
> {}

export const SecondaryIndex = Resource<SecondaryIndex>(
  "AWS.DynamoDB.SecondaryIndex",
);
