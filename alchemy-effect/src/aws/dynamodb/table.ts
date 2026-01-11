import * as S from "effect/Schema";
import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { type } from "../../type.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";
import type * as DynamoDB from "distilled-aws/dynamodb";

export interface TableProps<
  Items extends any = any,
  Attributes extends AttributesSchema<Items, PartitionKey, SortKey> =
    AttributesSchema<Items, keyof Items, keyof Items | undefined>,
  PartitionKey extends keyof Items = keyof Items,
  SortKey extends keyof Items | undefined = keyof Items | undefined,
> {
  items: type<Items>;
  attributes: Attributes;
  partitionKey: PartitionKey;
  sortKey?: SortKey;
  tableName?: string | undefined;
  billingMode?: DynamoDB.BillingMode;
  deletionProtectionEnabled?: boolean;
  onDemandThroughput?: DynamoDB.OnDemandThroughput;
  provisionedThroughput?: DynamoDB.ProvisionedThroughput;
  sseSpecification?: DynamoDB.SSESpecification;
  timeToLiveSpecification?: DynamoDB.TimeToLiveSpecification;
  warmThroughput?: DynamoDB.WarmThroughput;
  tableClass?: DynamoDB.TableClass;
}

export interface TableAttrs<Props extends Input.Resolve<TableProps>> {
  tableName: Props["tableName"] extends string ? Props["tableName"] : string;
  tableId: string;
  tableArn: `arn:aws:dynamodb:${RegionID}:${AccountID}:table/${this["tableName"]}`;
  partitionKey: Props["partitionKey"];
  sortKey: Props["sortKey"];
  // etc...
}

export type AttributesSchema<
  Items,
  PartitionKey extends keyof Items,
  SortKey extends keyof Items | undefined,
> = {
  [k in PartitionKey | (SortKey extends undefined ? never : SortKey)]: S.Schema<
    ToAttribute<Items[k]>
  >;
};

export type ToAttribute<S> = S extends string
  ? string
  : S extends number
    ? number
    : S extends Uint8Array | Buffer | File | Blob
      ? Uint8Array
      : S;

export const Table = Resource<{
  <
    const ID extends string,
    const Items,
    const Attributes extends NoInfer<
      AttributesSchema<Items, PartitionKey, SortKey>
    >,
    const PartitionKey extends keyof Items,
    const SortKey extends keyof Items | undefined = undefined,
  >(
    id: ID,
    props: TableProps<Items, Attributes, PartitionKey, SortKey>,
  ): Table<ID, TableProps<Items, Attributes, PartitionKey, SortKey>>;
}>("AWS.DynamoDB.Table");

export interface AnyTable extends Table<string, any> {}

export interface Table<
  ID extends string = string,
  Props extends TableProps<any, any, any, any> = TableProps<any, any, any, any>,
> extends Resource<
  "AWS.DynamoDB.Table",
  ID,
  Props,
  TableAttrs<Input.Resolve<Props>>,
  Table
> {}

export declare namespace Table {
  export type PartitionKey<T extends Table> = T["props"]["partitionKey"];
  export type SortKey<T extends Table> = T["props"]["sortKey"];
  export type Items<T extends Table> = T["props"]["items"];
  export type Key<T extends Table> = {
    [K in PartitionKey<T>]: InstanceType<T["props"]["items"]>[K];
  } & {
    [K in Exclude<SortKey<T>, undefined>]: Exclude<
      InstanceType<T["props"]["items"]>[K],
      undefined
    >;
  };
}
