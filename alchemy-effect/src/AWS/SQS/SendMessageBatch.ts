import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../Executable.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageBatchRequest extends Omit<
  sqs.SendMessageBatchRequest,
  "QueueUrl"
> {}

export class SendMessageBatch extends Binding.Service<
  SendMessageBatch,
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: SendMessageBatchRequest,
    ) => Effect.Effect<sqs.SendMessageBatchResult, sqs.SendMessageBatchError>
  >
>()("AWS.SQS.SendMessageBatch") {}

export const SendMessageBatchLive = Layer.effect(
  SendMessageBatch,
  Effect.gen(function* () {
    const Policy = yield* SendMessageBatchPolicy;
    const sendMessageBatch = yield* sqs.sendMessageBatch;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* Policy(queue);
      return Effect.fn(function* (request: SendMessageBatchRequest) {
        return yield* sendMessageBatch({
          ...request,
          QueueUrl: yield* QueueUrl,
        });
      });
    });
  }),
);

export class SendMessageBatchPolicy extends Binding.Policy<
  SendMessageBatchPolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.SendMessageBatch") {}

export const SendMessageBatchPolicyLive = Layer.effect(
  SendMessageBatchPolicy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* (queue: Queue) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "SendMessageBatch",
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: [Output.interpolate`${queue.queueArn}`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `SendMessageBatchPolicy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
