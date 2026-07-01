import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";
import {
  SendMessageBatch,
  type SendMessageBatchRequest,
} from "./SendMessageBatch.ts";

export const SendMessageBatchHttp = Layer.effect(
  SendMessageBatch,
  Effect.gen(function* () {
    const sendMessageBatch = yield* sqs.sendMessageBatch;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SQS.SendMessageBatch(${queue}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sqs:SendMessage"],
                Resource: [Output.interpolate`${queue.queueArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SQS.SendMessageBatch(${queue.LogicalId})`)(
        function* (request: SendMessageBatchRequest) {
          return yield* sendMessageBatch({
            ...request,
            QueueUrl: yield* QueueUrl,
          });
        },
      );
    });
  }),
);
