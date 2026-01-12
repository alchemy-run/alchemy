import * as Effect from "effect/Effect";

import * as Kinesis from "distilled-aws/kinesis";
import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import { toEnvKey } from "../../env.ts";
import { declare, type To } from "../../policy.ts";
import { Function } from "../lambda/function.ts";
import { Stream } from "./stream.ts";

export interface PutRecord<S = Stream> extends Capability<
  "AWS.Kinesis.PutRecord",
  S
> {}

export const PutRecord = Binding<
  <S extends Stream>(stream: S) => Binding<Function, PutRecord<To<S>>>
>(Function, "AWS.Kinesis.PutRecord");

export interface PutRecordOptions {
  /**
   * The partition key used to distribute records across shards.
   */
  partitionKey: string;
  /**
   * The hash value used to explicitly determine the shard the data record is assigned to.
   * Overrides partition key hashing.
   */
  explicitHashKey?: string;
  /**
   * Guarantees strictly increasing sequence numbers within a shard.
   */
  sequenceNumberForOrdering?: string;
}

export const putRecord = Effect.fnUntraced(function* <S extends Stream>(
  stream: S,
  data: S["props"]["schema"]["Type"],
  options: PutRecordOptions,
) {
  yield* declare<PutRecord<To<S>>>();
  const streamName = process.env[toEnvKey(stream.id, "STREAM_NAME")]!;
  return yield* Kinesis.putRecord({
    StreamName: streamName,
    Data: new TextEncoder().encode(JSON.stringify(data)),
    PartitionKey: options.partitionKey,
    ExplicitHashKey: options.explicitHashKey,
    SequenceNumberForOrdering: options.sequenceNumberForOrdering,
  });
});

export interface PutRecordsEntry<Data> {
  /**
   * The data for the record.
   */
  data: Data;
  /**
   * The partition key used to distribute records across shards.
   */
  partitionKey: string;
  /**
   * The hash value used to explicitly determine the shard the data record is assigned to.
   */
  explicitHashKey?: string;
}

export const putRecords = Effect.fnUntraced(function* <S extends Stream>(
  stream: S,
  records: PutRecordsEntry<S["props"]["schema"]["Type"]>[],
) {
  yield* declare<PutRecord<To<S>>>();
  const streamName = process.env[toEnvKey(stream.id, "STREAM_NAME")]!;
  return yield* Kinesis.putRecords({
    StreamName: streamName,
    Records: records.map((r) => ({
      Data: new TextEncoder().encode(JSON.stringify(r.data)),
      PartitionKey: r.partitionKey,
      ExplicitHashKey: r.explicitHashKey,
    })),
  });
});

export const putRecordFromLambdaFunction = () =>
  PutRecord.provider.succeed({
    attach: ({ source: stream }) => ({
      env: {
        [toEnvKey(stream.id, "STREAM_NAME")]: stream.attr.streamName,
        [toEnvKey(stream.id, "STREAM_ARN")]: stream.attr.streamArn,
      },
      policyStatements: [
        {
          Sid: "PutRecord",
          Effect: "Allow",
          Action: ["kinesis:PutRecord", "kinesis:PutRecords"],
          Resource: [stream.attr.streamArn],
        },
      ],
    }),
  });
