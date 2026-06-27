import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isInstance } from "../EC2/Instance.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";
import {
  DeleteMessageBatch,
  type DeleteMessageBatchRequest,
} from "./DeleteMessageBatch.ts";

export const DeleteMessageBatchHttp = Layer.effect(
  DeleteMessageBatch,
  Effect.gen(function* () {
    const deleteMessageBatch = yield* sqs.deleteMessageBatch;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host) || isInstance(host)) {
          yield* host.bind`Allow(${host}, AWS.SQS.DeleteMessageBatch(${queue}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sqs:DeleteMessage"],
                  Resource: [Output.interpolate`${queue.queueArn}`],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SQS.DeleteMessageBatch(${queue.LogicalId})`)(
        function* (request: DeleteMessageBatchRequest) {
          return yield* deleteMessageBatch({
            ...request,
            QueueUrl: yield* QueueUrl,
          });
        },
      );
    });
  }),
);
