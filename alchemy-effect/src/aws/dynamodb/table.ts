import * as S from "effect/Schema";
import { Resource } from "../../resource.ts";
import type { type } from "../../type.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";

import type * as DynamoDB from "itty-aws/dynamodb";

export interface TableProps<
  Items = any,
  Attributes extends AttributesSchema<
    Items,
    PartitionKey,
    SortKey
  > = AttributesSchema<Items, keyof Items, keyof Items | undefined>,
  PartitionKey extends keyof Items = keyof Items,
  SortKey extends keyof Items | undefined = keyof Items | undefined,
  BillingMode extends DynamoDB.BillingMode = DynamoDB.BillingMode,
  SSESpecification extends DynamoDB.SSESpecification | undefined =
    | DynamoDB.SSESpecification
    | undefined,
  TimeToLiveSpecification extends DynamoDB.TimeToLiveSpecification | undefined =
    | DynamoDB.TimeToLiveSpecification
    | undefined,
  WarmThroughput extends DynamoDB.WarmThroughput | undefined =
    | DynamoDB.WarmThroughput
    | undefined,
  OnDemandThroughput extends DynamoDB.OnDemandThroughput | undefined =
    | DynamoDB.OnDemandThroughput
    | undefined,
  ProvisionedThroughput extends DynamoDB.ProvisionedThroughput | undefined =
    | DynamoDB.ProvisionedThroughput
    | undefined,
  TableClass extends DynamoDB.TableClass | undefined =
    | DynamoDB.TableClass
    | undefined,
> {
  items: type<Items>;
  tableName?: string;
  attributes: Attributes;
  partitionKey: PartitionKey;
  sortKey?: SortKey;
  billingMode?: BillingMode;
  deletionProtectionEnabled?: boolean;
  onDemandThroughput?: OnDemandThroughput;
  provisionedThroughput?: ProvisionedThroughput;
  sseSpecification?: SSESpecification;
  timeToLiveSpecification?: TimeToLiveSpecification;
  warmThroughput?: WarmThroughput;
  tableClass?: TableClass;
}

export interface TableAttrs<Props extends TableProps> {
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
    const BillingMode extends DynamoDB.BillingMode = "PAY_PER_REQUEST",
    const SSESpecification extends
      | DynamoDB.SSESpecification
      | undefined = undefined,
    const TimeToLiveSpecification extends
      | DynamoDB.TimeToLiveSpecification
      | undefined = undefined,
    const WarmThroughput extends
      | DynamoDB.WarmThroughput
      | undefined = undefined,
    const OnDemandThroughput extends
      | DynamoDB.OnDemandThroughput
      | undefined = undefined,
    const ProvisionedThroughput extends
      | DynamoDB.ProvisionedThroughput
      | undefined = undefined,
    const TableClass extends DynamoDB.TableClass | undefined = undefined,
  >(
    id: ID,
    props: TableProps<
      Items,
      Attributes,
      PartitionKey,
      SortKey,
      BillingMode,
      SSESpecification,
      TimeToLiveSpecification,
      WarmThroughput,
      OnDemandThroughput,
      ProvisionedThroughput,
      TableClass
    >,
  ): Table<
    ID,
    TableProps<
      Items,
      Attributes,
      PartitionKey,
      SortKey,
      BillingMode,
      SSESpecification,
      TimeToLiveSpecification,
      WarmThroughput,
      OnDemandThroughput,
      ProvisionedThroughput,
      TableClass
    >
  >;
}>("AWS.DynamoDB.Table");

export interface Table<
  ID extends string = string,
  Props extends TableProps = TableProps,
> extends Resource<"AWS.DynamoDB.Table", ID, Props, TableAttrs<Props>> {}

export declare namespace Table {
  export type PartitionKey<T extends Table> = T["props"]["partitionKey"];
  export type SortKey<T extends Table> = T["props"]["sortKey"];
  export type Key<T extends Table> = {
    [K in PartitionKey<T>]: T["props"]["attributes"][K];
  } & SortKey<T> extends infer S extends string
    ? {
        [K in S]: T["props"]["attributes"][K];
      }
    : {};
}
