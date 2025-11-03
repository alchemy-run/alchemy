import { Binding, type Capability, type From } from "alchemy-effect";
import type * as lambda from "aws-lambda";
import { Function } from "../lambda/index.ts";
import { Queue } from "./queue.ts";

export type QueueRecord<Data> = Omit<lambda.SQSRecord, "body"> & {
  body: Data;
};

export type QueueEvent<Data> = Omit<lambda.SQSEvent, "Records"> & {
  Records: QueueRecord<Data>[];
};

export interface Consume<Q = Queue> extends Capability<"AWS.SQS.Consume", Q> {}

export interface QueueEventSourceProps {
  batchSize?: number;
  maxBatchingWindow?: number;
  maxConcurrency?: number;
  reportBatchItemFailures?: boolean;
}

export const QueueEventSource = Binding<
  <Q extends Queue, const Props extends QueueEventSourceProps>(
    queue: Q,
    props?: Props,
  ) => Binding<Function, Consume<From<Q>>, Props, "QueueEventSource">
>(Function, "AWS.SQS.Consume", "QueueEventSource");

export const consumeFromLambdaFunction = () =>
  QueueEventSource.provider.succeed({
    attach: ({ source: queue }) => ({
      policyStatements: [
        {
          Sid: "AWS.SQS.Consume",
          Effect: "Allow",
          Action: [
            "sqs:ReceiveMessage",
            "sqs:DeleteMessage",
            "sqs:ChangeMessageVisibility",
          ],
          Resource: [queue.attr.queueArn],
        },
      ],
    }),
  });
