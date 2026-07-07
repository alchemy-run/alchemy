import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isInstance } from "../EC2/Instance.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";
import { SendMessage, type SendMessageRequest } from "./SendMessage.ts";

export const SendMessageHttp = Layer.effect(
  SendMessage,
  Effect.gen(function* () {
    const sendMessage = yield* sqs.sendMessage;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host) || isInstance(host)) {
          yield* host.bind`Allow(${host}, AWS.SQS.SendMessage(${queue}))`({
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
      return Effect.fn(`AWS.SQS.SendMessage(${queue.LogicalId})`)(function* (
        request: SendMessageRequest,
      ) {
        return yield* sendMessage({
          ...request,
          QueueUrl: yield* QueueUrl,
          MessageBody: request.MessageBody,
        });
      });
    });
  }),
);
