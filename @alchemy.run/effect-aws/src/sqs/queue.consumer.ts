import type * as lambda from "aws-lambda";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

import * as Alchemy from "@alchemy.run/effect";
import type * as IAM from "../iam.ts";
import { FunctionClient } from "../lambda/function.client.ts";
import type { Queue } from "./queue.ts";

export type SQSRecord<Q extends Queue> = Omit<lambda.SQSRecord, "body"> & {
  body: Q["props"]["message"]["Type"];
  messageAttributes: lambda.SQSMessageAttributes;
};

export type SQSEvent<Q extends Queue> = lambda.SQSEvent & {
  Records: SQSRecord<Q>[];
};

export class Consume<Q extends Queue> extends Alchemy.Service(
  "AWS::SQS::Queue.Consumer",
)<
  (
    input: lambda.SQSEvent,
    context: lambda.Context,
  ) => lambda.SQSBatchResponse | void
>() {
  constructor(queue: Q) {
    super({
      label: `AWS.SQS.Consume(${queue.id})`,
      effect: "Allow",
      action: "sqs:Consume",
      resource: queue,
      binding: Consume,
    });
  }
}

export const consume = <const ID extends string, Q extends Queue, Err, Req>(
  queue: Q,
  id: ID,
  handler: (
    input: SQSEvent<Q>,
    context: lambda.Context,
  ) => Effect.Effect<lambda.SQSBatchResponse | void, Err, Req>,
) =>
  Alchemy.service(
    id,
    new Consume<Q>(queue),
    Effect.fn(function* (input, context) {
      return yield* handler(
        {
          Records: yield* Effect.all(
            input.Records.map(
              Effect.fn(function* (record) {
                const body = yield* S.validate(queue.props.message)(
                  record.body,
                );
                return {
                  ...record,
                  body: body as Q["props"]["message"]["Type"],
                } satisfies SQSRecord<Q>;
              }),
            ),
          ),
        },
        context,
      );
    }),
  );

export const bindConsumer = Layer.effect(
  Consume,
  Effect.gen(function* () {
    const lambda = yield* FunctionClient;
    return {
      attach: Effect.fn(function* (queue, { functionName }) {
        const props = {
          FunctionName: functionName,
          EventSourceArn: queue.queueArn,
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
                EventSourceArn: queue.queueArn,
              })
              .pipe(
                Effect.flatMap((mappings) =>
                  !mappings.EventSourceMappings?.[0]?.UUID
                    ? Effect.die(
                        new Error(
                          `Event source mapping not found for function ${functionName} and queue ${queue.queueArn}`,
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
              Resource: queue.queueArn,
            } as const satisfies IAM.PolicyStatement,
          ],
        };
      }),
      detach: Effect.fn(function* (queue, { functionName }) {
        yield* lambda
          .listEventSourceMappings({
            FunctionName: functionName,
            EventSourceArn: queue.queueArn,
          })
          .pipe(
            Effect.flatMap((mappings) =>
              !mappings.EventSourceMappings?.[0]?.UUID
                ? Effect.die(
                    new Error(
                      `Event source mapping not found for function ${functionName} and queue ${queue.queueArn}`,
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
          );
      }),
    };
  }),
);
