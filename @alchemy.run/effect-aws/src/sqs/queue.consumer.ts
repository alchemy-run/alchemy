import type * as lambda from "aws-lambda";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { Handler, type Allow } from "@alchemy.run/effect";
import type * as IAM from "../iam.ts";
import { FunctionClient } from "../lambda/function.client.ts";
import type * as Lambda from "../lambda/index.ts";
import type { Queue } from "./queue.ts";

export const consume = <const ID extends string, Q extends Queue, Err, Req>(
  id: ID,
  queue: Q,
  handler: (
    event: lambda.SQSEvent,
    context: lambda.Context,
  ) => Effect.Effect<lambda.SQSBatchResponse | void, Err, Req>,
) =>
  Handler({
    type: "AWS::SQS::Consumer",
    id,
    handler,
    binding: Consume(queue),
  });

export type Consume<Q extends Queue> = Allow<"sqs:Consume", Q>;

export const Consume = <Q extends Queue>(queue: Q): Consume<Q> =>
  ({
    label: `AWS.SQS.Consume(${queue.id})`,
    effect: "Allow",
    action: "sqs:Consume",
    resource: queue,
    binder: QueueConsumerBinder,
  }) as const;

export class QueueConsumerBinder extends Context.Tag(
  "AWS::SQS::Queue.EventSource",
)<QueueConsumerBinder, Lambda.FunctionBinding<Consume<Queue>>>() {}

export const queueConsumerBinder = () =>
  Layer.effect(
    QueueConsumerBinder,
    Effect.gen(function* () {
      const lambda = yield* FunctionClient;

      return {
        attach: Effect.fn(function* ({
          host: { functionName },
          resource: { queueArn },
        }) {
          const props = {
            FunctionName: functionName,
            EventSourceArn: queueArn,
            Enabled: true,
            // TODO(sam): support configuring lots of other options
            Tags: {
              // TODO
            },
          };
          yield* lambda.createEventSourceMapping(props).pipe(
            Effect.catchTag("ResourceConflictException", () =>
              lambda
                .listEventSourceMappings({
                  FunctionName: functionName,
                  EventSourceArn: queueArn,
                })
                .pipe(
                  Effect.flatMap((mappings) =>
                    !mappings.EventSourceMappings?.[0]?.UUID
                      ? Effect.die(
                          new Error(
                            `Event source mapping not found for function ${functionName} and queue ${queueArn}`,
                          ),
                        )
                      : lambda.updateEventSourceMapping({
                          UUID: mappings.EventSourceMappings?.[0]?.UUID!,
                          ...props,
                        }),
                  ),
                ),
            ),
            Effect.retry({
              while: (e) => e.name === "ResourceNotFoundException",
              schedule: Schedule.fixed(1000),
            }),
            Effect.catchAll(Effect.die),
          );
          return {
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "sqs:ReceiveMessage",
                  "sqs:DeleteMessage",
                  "sqs:GetQueueAttributes",
                  "sqs:GetQueueUrl",
                  "sqs:ChangeMessageVisibility",
                ],
                Resource: queueArn,
              } as const satisfies IAM.PolicyStatement,
            ],
          };
        }),
        detach: ({ host: { functionName }, resource: { queueArn } }) =>
          lambda
            .listEventSourceMappings({
              FunctionName: functionName,
              EventSourceArn: queueArn,
            })
            .pipe(
              Effect.flatMap((mappings) =>
                !mappings.EventSourceMappings?.[0]?.UUID
                  ? Effect.die(
                      new Error(
                        `Event source mapping not found for function ${functionName} and queue ${queueArn}`,
                      ),
                    )
                  : Effect.succeed(mappings.EventSourceMappings?.[0]?.UUID!),
              ),
              Effect.flatMap((uuid) =>
                lambda.deleteEventSourceMapping({
                  UUID: uuid,
                }),
              ),
              Effect.catchAll(Effect.die),
            ),
      } satisfies Lambda.FunctionBinding<Consume<Queue>>;
    }),
  );
