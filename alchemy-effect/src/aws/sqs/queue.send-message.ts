import * as Effect from "effect/Effect";

import {
  Binding,
  declare,
  toEnvKey,
  type Capability,
  type To,
} from "alchemy-effect";
import { Function } from "../lambda/index.ts";
import { SQSClient } from "./client.ts";
import { Queue } from "./queue.ts";

export interface SendMessage<Q = Queue>
  extends Capability<"AWS.SQS.SendMessage", Q> {}

export const SendMessage = Binding<
  <Q extends Queue>(queue: Q) => Binding<Function, SendMessage<To<Q>>>
>(Function, "AWS.SQS.SendMessage");

export const sendMessage = <Q extends Queue>(
  queue: Q,
  message: Q["props"]["schema"]["Type"],
) =>
  Effect.gen(function* () {
    yield* declare<SendMessage<To<Q>>>();
    const sqs = yield* SQSClient;
    const url = process.env[toEnvKey(queue.id, "QUEUE_URL")]!;
    return yield* sqs.sendMessage({
      QueueUrl: url,
      MessageBody: JSON.stringify(message),
    });
  });

export const sendMessageFromLambdaFunction = () =>
  SendMessage.provider.succeed({
    attach: ({ source: queue }) => ({
      env: {
        // ask what attribute is needed to interact? e.g. is it the Queue ARN or the Queue URL?
        [toEnvKey(queue.id, "QUEUE_URL")]: queue.attr.queueUrl,
      },
      policyStatements: [
        {
          Sid: "SendMessage",
          Effect: "Allow",
          Action: ["sqs:SendMessage"], // <- ask LLM how to generate this
          Resource: [queue.attr.queueArn],
        },
      ],
    }),
  });
