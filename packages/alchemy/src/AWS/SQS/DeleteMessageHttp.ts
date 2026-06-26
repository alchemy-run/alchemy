import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";
import { DeleteMessage, type DeleteMessageRequest } from "./DeleteMessage.ts";

export const DeleteMessageHttp = Layer.effect(
  DeleteMessage,
  Effect.gen(function* () {
    const deleteMessage = yield* sqs.deleteMessage;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SQS.DeleteMessage(${queue}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sqs:DeleteMessage"],
                Resource: [Output.interpolate`${queue.queueArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SQS.DeleteMessage(${queue.LogicalId})`)(function* (
        request: DeleteMessageRequest,
      ) {
        return yield* deleteMessage({
          ...request,
          QueueUrl: yield* QueueUrl,
        });
      });
    });
  }),
);
