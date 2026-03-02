import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageRequest extends Omit<
  sqs.SendMessageRequest,
  "QueueUrl"
> {}

export class SendMessage extends Binding.Service<
  SendMessage,
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: SendMessageRequest,
    ) => Effect.Effect<sqs.SendMessageResult, sqs.SendMessageError>
  >
>()("AWS.SQS.SendMessage") {}

export const SendMessageLive = Layer.effect(
  SendMessage,
  Effect.gen(function* () {
    const Policy = yield* SendMessagePolicy;
    const sendMessage = yield* sqs.sendMessage;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* Policy(queue);
      return Effect.fn(function* (request: SendMessageRequest) {
        return yield* sendMessage({
          ...request,
          QueueUrl: yield* QueueUrl,
          MessageBody: request.MessageBody,
        });
      });
    });
  }),
);

export class SendMessagePolicy extends Binding.Policy<
  SendMessagePolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.SendMessage") {}

export const SendMessagePolicyLive = SendMessagePolicy.layer.succeed(
  Effect.fn(function* (ctx, queue: Queue) {
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "SendMessage",
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: [Output.interpolate`${queue.queueArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `SendMessagePolicy does not support runtime '${ctx.type}'`,
      );
    }
  }),
);
