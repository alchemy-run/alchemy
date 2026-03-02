import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Binding from "../../Binding.ts";
import type { SQSRecord } from "../SQS/index.ts";
import * as SQS from "../SQS/index.ts";
import type { Queue } from "../SQS/Queue.ts";
import type { QueueEventSourceProps } from "../SQS/QueueEventSource.ts";
import { EventSourceMapping } from "./EventSourceMapping.ts";
import { FunctionRuntime } from "./FunctionRuntime.ts";

export const isSQSEvent = (event: any): event is lambda.SQSEvent =>
  Array.isArray(event?.Records) &&
  event.Records.length > 0 &&
  event.Records[0].eventSource === "aws:sqs";

export const QueueEventSource = Layer.effect(
  SQS.QueueEventSource,
  // @ts-expect-error
  Effect.gen(function* () {
    const Function = yield* FunctionRuntime;
    const Policy = yield* QueueEventSourcePolicy;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      queue: Queue,
      props: QueueEventSourceProps,
      process: (
        stream: Stream.Stream<SQSRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req | StreamReq>,
    ) {
      yield* Policy(queue, props);

      yield* Function.listen(
        Effect.gen(function* () {
          return (event: any) => {
            if (isSQSEvent(event)) {
              const eff = process(Stream.fromArray(event.Records)).pipe(
                Effect.orDie,
              );
              return eff;
            }
          };
        }),
      );
    });
  }),
);

export class QueueEventSourcePolicy extends Binding.Policy<
  QueueEventSourcePolicy,
  (queue: Queue, props: QueueEventSourceProps) => Effect.Effect<void>
>()("AWS.SQS.QueueEventSourcePolicy") {}

export const QueueEventSourcePolicyLive = Layer.effect(
  QueueEventSourcePolicy,
  Effect.gen(function* () {
    const Function = yield* FunctionRuntime;
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* (queue, props) {
      yield* Function.bind({
        policyStatements: [
          {
            Sid: "QueueEventSource",
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
            ],
            Resource: [queue.queueArn],
          },
        ],
      });

      yield* Mapping(`${queue.LogicalId}-EventSource`, {
        functionName: Function.functionName,
        eventSourceArn: queue.queueArn,
        batchSize: props.batchSize,
        maximumBatchingWindowInSeconds: props.maximumBatchingWindowInSeconds,
        enabled: true,
      });
    });
  }),
);
