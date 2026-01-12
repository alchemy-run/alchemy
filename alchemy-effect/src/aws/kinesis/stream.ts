import type * as S from "effect/Schema";
import { Resource } from "../../resource.ts";
// required to avoid this error in consumers: "The inferred type of 'Messages' cannot be named without a reference to '../../distilled-aws/node_modules/@types/aws-lambda'. This is likely not portable. A type annotation is necessary.ts(2742)"
export type * as lambda from "aws-lambda";

export const Stream = Resource<{
  <const ID extends string, const Props extends StreamProps>(
    id: ID,
    props: Props,
  ): Stream<ID, Props>;
}>("AWS.Kinesis.Stream");

export interface Stream<
  ID extends string = string,
  Props extends StreamProps = StreamProps,
> extends Resource<"AWS.Kinesis.Stream", ID, Props, StreamAttrs<Props>, Stream> {}

export type StreamAttrs<Props extends StreamProps> = {
  streamName: Props["streamName"] extends string ? Props["streamName"] : string;
  streamArn: `arn:aws:kinesis:${string}:${string}:stream/${Props["streamName"] extends string ? Props["streamName"] : string}`;
  streamStatus: StreamStatus;
};

export type StreamStatus =
  | "CREATING"
  | "DELETING"
  | "ACTIVE"
  | "UPDATING";

export type StreamMode = "PROVISIONED" | "ON_DEMAND";

export type StreamProps<Data = any> = {
  /**
   * Schema for the record data.
   */
  schema: S.Schema<Data>;
  /**
   * Name of the stream.
   * @default ${app}-${stage}-${id}
   */
  streamName?: string;
  /**
   * The capacity mode of the data stream.
   * - PROVISIONED: You specify the number of shards for the data stream.
   * - ON_DEMAND: AWS manages the shards for the data stream.
   * @default "ON_DEMAND"
   */
  streamMode?: StreamMode;
  /**
   * The number of shards that the stream will use when in PROVISIONED mode.
   * Required when streamMode is "PROVISIONED".
   * @default undefined (required for PROVISIONED mode)
   */
  shardCount?: number;
  /**
   * The number of hours for the data records that are stored in shards to remain accessible.
   * The retention period ranges from 24 hours (1 day) to 8760 hours (365 days).
   * @default 24
   */
  retentionPeriodHours?: number;
  /**
   * If set to true, server-side encryption is enabled on the stream.
   * Uses the AWS managed CMK for Kinesis (alias/aws/kinesis).
   * @default false
   */
  encryption?: boolean;
  /**
   * The GUID for the customer-managed AWS KMS key to use for encryption.
   * Only relevant when encryption is enabled.
   * If not specified, AWS managed CMK for Kinesis is used.
   */
  kmsKeyId?: string;
  /**
   * A list of shard-level CloudWatch metrics to enable for the stream.
   * Valid values: IncomingBytes, IncomingRecords, OutgoingBytes, OutgoingRecords, WriteProvisionedThroughputExceeded, ReadProvisionedThroughputExceeded, IteratorAgeMilliseconds, ALL
   */
  shardLevelMetrics?: ShardLevelMetric[];
  /**
   * Tags to associate with the stream.
   */
  tags?: Record<string, string>;
};

export type ShardLevelMetric =
  | "IncomingBytes"
  | "IncomingRecords"
  | "OutgoingBytes"
  | "OutgoingRecords"
  | "WriteProvisionedThroughputExceeded"
  | "ReadProvisionedThroughputExceeded"
  | "IteratorAgeMilliseconds"
  | "ALL";
