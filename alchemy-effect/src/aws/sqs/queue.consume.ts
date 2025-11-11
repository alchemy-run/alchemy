import { type Capability } from "alchemy-effect";
import type * as lambda from "aws-lambda";
import { Queue } from "./queue.ts";

export type QueueRecord<Data> = Omit<lambda.SQSRecord, "body"> & {
  body: Data;
};

export type QueueEvent<Data> = Omit<lambda.SQSEvent, "Records"> & {
  Records: QueueRecord<Data>[];
};

export interface Consume<Q = Queue> extends Capability<"AWS.SQS.Consume", Q> {}
