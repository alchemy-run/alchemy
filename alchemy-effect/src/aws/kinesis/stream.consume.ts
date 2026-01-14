import type * as lambda from "aws-lambda";
import type { Capability } from "../../capability.ts";
import { Stream } from "./stream.ts";

export type StreamRecord<Data> = Omit<lambda.KinesisStreamRecord, "kinesis"> & {
  kinesis: Omit<lambda.KinesisStreamRecordPayload, "data"> & {
    data: Data;
  };
};

export type StreamEvent<Data> = Omit<lambda.KinesisStreamEvent, "Records"> & {
  Records: StreamRecord<Data>[];
};

export interface Consume<S = Stream> extends Capability<
  "AWS.Kinesis.Consume",
  S
> {}
