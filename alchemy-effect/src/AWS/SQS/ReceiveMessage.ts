import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../Executable.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface ReceiveMessageRequest extends Omit<
  sqs.ReceiveMessageRequest,
  "QueueUrl"
> {}

export class ReceiveMessage extends Binding.Service<
  ReceiveMessage,
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: ReceiveMessageRequest,
    ) => Effect.Effect<sqs.ReceiveMessageResult, sqs.ReceiveMessageError>
  >
>()("AWS.SQS.ReceiveMessage") {}

export const ReceiveMessageLive = Layer.effect(
  ReceiveMessage,
  Effect.gen(function* () {
    const Policy = yield* ReceiveMessagePolicy;
    const receiveMessage = yield* sqs.receiveMessage;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* Policy(queue);
      return Effect.fn(function* (request: ReceiveMessageRequest) {
        return yield* receiveMessage({
          ...request,
          QueueUrl: yield* QueueUrl,
        });
      });
    });
  }),
);

export class ReceiveMessagePolicy extends Binding.Policy<
  ReceiveMessagePolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.ReceiveMessage") {}

export const ReceiveMessagePolicyLive = Layer.effect(
  ReceiveMessagePolicy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* (queue: Queue) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "ReceiveMessage",
              Effect: "Allow",
              Action: ["sqs:ReceiveMessage"],
              Resource: [Output.interpolate`${queue.queueArn}`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `ReceiveMessagePolicy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
