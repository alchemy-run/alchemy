import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isInstance } from "../EC2/Instance.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";
import {
  ReceiveMessage,
  type ReceiveMessageRequest,
} from "./ReceiveMessage.ts";

export const ReceiveMessageHttp = Layer.effect(
  ReceiveMessage,
  Effect.gen(function* () {
    const receiveMessage = yield* sqs.receiveMessage;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host) || isInstance(host)) {
          yield* host.bind`Allow(${host}, AWS.SQS.ReceiveMessage(${queue}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sqs:ReceiveMessage"],
                Resource: [Output.interpolate`${queue.queueArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SQS.ReceiveMessage(${queue.LogicalId})`)(function* (
        request: ReceiveMessageRequest,
      ) {
        return yield* receiveMessage({
          ...request,
          QueueUrl: yield* QueueUrl,
        });
      });
    });
  }),
);
