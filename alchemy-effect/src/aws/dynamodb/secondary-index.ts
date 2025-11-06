import * as S from "effect/Schema";
import { Resource } from "../../resource.ts";
import type { Table } from "./table.ts";

export const SecondaryIndex = Resource<{
  <
    const ID extends string,
    const Source extends Table,
    const Attributes extends S.Struct.Fields,
    const PartitionKey extends keyof Attributes,
    const SortKey extends keyof Attributes | undefined = undefined,
  >(
    id: ID,
    props: SecondaryIndexProps<Source, Attributes, PartitionKey, SortKey>,
  ): SecondaryIndex<
    ID,
    SecondaryIndexProps<Source, Attributes, PartitionKey, SortKey>
  >;
}>("AWS.DynamoDB.SecondaryIndex");

export interface SecondaryIndex<
  ID extends string = string,
  Props extends SecondaryIndexProps = SecondaryIndexProps,
> extends Resource<
    "AWS.DynamoDB.SecondaryIndex",
    ID,
    Props,
    SecondaryIndexAttrs<Props>
  > {}

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

export type SecondaryIndexAttrs<Props extends SecondaryIndexProps> = {
  indexName: Props["indexName"] extends string ? Props["indexName"] : string;
};
