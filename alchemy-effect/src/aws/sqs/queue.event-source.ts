import { Binding, type From } from "alchemy-effect";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Lambda from "itty-aws/lambda";
import { createTagger, hasTags } from "../../tags.ts";
import { Account } from "../account.ts";
import {
  Function,
  LambdaClient,
  type FunctionBinding,
} from "../lambda/index.ts";
import { Region } from "../region.ts";
import type { Consume } from "./queue.consume.ts";
import { Queue, type QueueAttrs, type QueueProps } from "./queue.ts";

export interface QueueEventSourceProps {
  batchSize?: number;
  maxBatchingWindow?: number;
  scalingConfig?: Lambda.ScalingConfig;
}

export interface QueueEventSourceAttr extends FunctionBinding {
  uuid: string;
}

export interface QueueEventSource<
  Q extends Queue,
  Props extends QueueEventSourceProps,
> extends Binding<
    Function,
    Consume<From<Q>>,
    Props,
    QueueEventSourceAttr,
    "QueueEventSource"
  > {}

export const QueueEventSource = Binding<
  <Q extends Queue, const Props extends QueueEventSourceProps>(
    queue: Q,
    props?: Props,
  ) => QueueEventSource<Q, Props>
>(Function, "AWS.SQS.Consume", "QueueEventSource");

export const queueEventSourceProvider = () =>
  QueueEventSource.provider.effect(
    // @ts-expect-error
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;
      const lambda = yield* LambdaClient;
      const tagged = yield* createTagger();

      const findEventSourceMapping: (
        queue: {
          id: string;
          attr: QueueAttrs<QueueProps<any>>;
          props: QueueProps<any>;
        },
        functionName: string,
        marker?: string,
      ) => Effect.Effect<Lambda.EventSourceMappingConfiguration | undefined> =
        Effect.fn(function* (queue, functionName, marker) {
          const retry = Effect.retry({
            while: (
              e:
                | Lambda.InvalidParameterValueException
                | Lambda.ResourceNotFoundException
                | Lambda.ServiceException
                | Lambda.TooManyRequestsException
                | Lambda.CommonAwsError
                | any,
            ) =>
              // TODO(sam): figure out how to write a function that generalizes this or upstream into itty-aws
              e._tag === "InternalFailure" ||
              e._tag === "RequestExpired" ||
              e._tag === "ServiceException" ||
              e._tag === "ServiceUnavailable" ||
              e._tag === "ThrottlingException" ||
              e._tag === "TooManyRequestsException",
            schedule: Schedule.exponential(100),
          });

          // TODO(sam): return an accepted error
          // const orDie = Effect.catchAll((e) => Effect.die(e));

          const mappings = yield* lambda
            .listEventSourceMappings({
              FunctionName: functionName,
              Marker: marker,
            })
            .pipe(retry, Effect.orDie);
          const mapping = mappings.EventSourceMappings?.find(
            (mapping) => mapping.EventSourceArn === queue.attr.queueArn,
          );
          if (mapping?.EventSourceArn) {
            const { Tags } = yield* lambda
              .listTags({
                Resource: `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${mapping.UUID!}`,
              })
              .pipe(retry, Effect.orDie);
            if (hasTags(tagged(queue.id), Tags)) {
              return mapping;
            }
            return undefined;
          }
          if (mappings.NextMarker) {
            return yield* findEventSourceMapping(
              queue,
              functionName,
              mappings.NextMarker,
            );
          }
          return undefined;
        });

      const createFunctionBinding = (queue: {
        attr: { queueArn: string };
      }) => ({
        // we need the policies to be present before the event source mapping is created
        policyStatements: [
          {
            Sid: "AWS.SQS.Consume",
            Effect: "Allow" as const,
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:ChangeMessageVisibility",
            ],
            Resource: [queue.attr.queueArn],
          },
        ],
      });

      return {
        attach: ({ source: queue }) => {
          console.log("attaching queue event source", queue.id);
          return {
            // we need the policies to be present before the event source mapping is created
            policyStatements: [
              {
                Sid: "AWS.SQS.Consume",
                Effect: "Allow" as const,
                Action: [
                  "sqs:ReceiveMessage",
                  "sqs:DeleteMessage",
                  "sqs:ChangeMessageVisibility",
                  "sqs:GetQueueAttributes",
                  "sqs:GetQueueUrl",
                ],
                Resource: [queue.attr.queueArn],
              },
            ],
          };
        },
        postattach: Effect.fn(function* ({
          source: queue,
          props: { batchSize, maxBatchingWindow, scalingConfig } = {},
          attr,
          target: {
            attr: { functionName },
          },
        }) {
          console.log(
            "postattaching queue event source",
            queue.id,
            functionName,
          );
          const config:
            | Lambda.CreateEventSourceMappingRequest
            | Lambda.UpdateEventSourceMappingRequest = {
            FunctionName: functionName,
            EventSourceArn: queue.attr.queueArn,
            BatchSize: batchSize,
            MaximumBatchingWindowInSeconds: maxBatchingWindow,
            ScalingConfig: scalingConfig,
            Enabled: true,
            FunctionResponseTypes: ["ReportBatchItemFailures"],
            // https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html#event-source-mapping-metrics
            MetricsConfig: { Metrics: ["EventCount"] },
            // KMSKeyArn: (encrypted FilterCriteria)

            // See: https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
            // FilterCriteria: {
            //   Filters: [{Pattern: ""}]
            // }
            Tags: tagged(queue.id),
          };

          const findOrDie = findEventSourceMapping(queue, functionName).pipe(
            Effect.flatMap((mapping) =>
              mapping
                ? Effect.succeed(mapping)
                : Effect.die(
                    // how the fuck did we get here?
                    new Error(
                      `QueueEventSource(${queue.id}) not found on function ${functionName}`,
                    ),
                  ),
            ),
          );

          const eventSourceMapping = yield* (
            attr?.uuid
              ? lambda.updateEventSourceMapping({
                  ...config,
                  UUID: attr.uuid,
                })
              : lambda.createEventSourceMapping(config)
          ).pipe(
            Effect.catchTags({
              ResourceConflictException: () => findOrDie,
              ResourceNotFoundException: () => findOrDie,
            }),
            Effect.retry({
              // It takes a few seconds for the IAM policy to propagate, so retry the following error
              while: (e) =>
                e.name === "InvalidParameterValueException" &&
                e.message?.includes(
                  "The function execution role does not have permissions to call",
                ),
              schedule: Schedule.exponential(100),
            }),
          );
          return {
            ...attr,
            uuid: eventSourceMapping.UUID,
          };
        }),
        detach: Effect.fn(function* ({
          source: queue,
          target: {
            attr: { functionName },
          },
          attr,
        }) {
          const uuid =
            attr?.uuid ??
            (yield* findEventSourceMapping(queue, functionName))?.UUID!;
          if (uuid) {
            // we found (or were aware of) the event source mapping, so we can delete it
            yield* (
              lambda
                .deleteEventSourceMapping({
                  UUID: uuid,
                })
                // TODO(sam): handle errors properly
                .pipe(Effect.catchAll(() => Effect.void))
            );
          }
        }),
      };
    }),
  );
