import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Lambda from "distilled-aws/lambda";
import { Binding } from "../../binding.ts";
import type { From } from "../../policy.ts";
import { createInternalTags, hasTags } from "../../tags.ts";
import type { Consume } from "./stream.consume.ts";
import { Stream, type StreamAttrs, type StreamProps } from "./stream.ts";
import { Function, type FunctionBinding } from "../lambda/function.ts";
import * as lambda from "distilled-aws/lambda";
import { Account } from "../account.ts";
import { Region } from "distilled-aws/Region";
import type { App } from "../../index.ts";
import type { CommonAwsError } from "distilled-aws/Errors";
import type { Credentials } from "distilled-aws/Credentials";
import type { HttpClient } from "@effect/platform/HttpClient";

export type StartingPosition = "TRIM_HORIZON" | "LATEST" | "AT_TIMESTAMP";

export interface StreamEventSourceProps {
  /**
   * The number of records to send to the function in each batch.
   * @default 100
   */
  batchSize?: number;
  /**
   * The maximum amount of time to gather records before invoking the function, in seconds.
   * @default 0
   */
  maxBatchingWindow?: number;
  /**
   * The position in the stream where Lambda starts reading.
   * @default "TRIM_HORIZON"
   */
  startingPosition?: StartingPosition;
  /**
   * The timestamp to start reading from (only used when startingPosition is AT_TIMESTAMP).
   */
  startingPositionTimestamp?: Date;
  /**
   * The number of batches to process from each shard concurrently.
   * @default 1
   */
  parallelizationFactor?: number;
  /**
   * Split a batch on function error and retry the remaining records.
   * @default false
   */
  bisectBatchOnFunctionError?: boolean;
  /**
   * The maximum age of a record that Lambda sends to a function for processing.
   * @default -1 (infinite)
   */
  maximumRecordAgeInSeconds?: number;
  /**
   * The maximum number of times to retry when the function returns an error.
   * @default -1 (infinite)
   */
  maximumRetryAttempts?: number;
  /**
   * The duration of a processing window in seconds for tumbling windows.
   */
  tumblingWindowInSeconds?: number;
  /**
   * Scaling configuration for the event source.
   */
  scalingConfig?: Lambda.ScalingConfig;
}

export interface StreamEventSourceAttr extends FunctionBinding {
  uuid: string;
}

export interface StreamEventSource<
  S extends Stream,
  Props extends StreamEventSourceProps,
> extends Binding<
  Function,
  Consume<From<S>>,
  Props,
  StreamEventSourceAttr,
  "StreamEventSource"
> {}

export const StreamEventSource = Binding<
  <S extends Stream, const Props extends StreamEventSourceProps>(
    stream: S,
    props?: Props,
  ) => StreamEventSource<S, Props>
>(Function, "AWS.Kinesis.Consume", "StreamEventSource");

export const streamEventSourceProvider = () =>
  StreamEventSource.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;
      const region = yield* Region;

      const findEventSourceMapping: (
        stream: {
          id: string;
          attr: StreamAttrs<StreamProps<any>>;
          props: StreamProps<any>;
        },
        functionName: string,
        marker?: string,
      ) => Effect.Effect<
        Lambda.EventSourceMappingConfiguration | undefined,
        never,
        App | Credentials | Region | HttpClient
      > = Effect.fn(function* (stream, functionName, marker) {
        const retry = Effect.retry({
          while: (
            e:
              | Lambda.InvalidParameterValueException
              | Lambda.ResourceNotFoundException
              | Lambda.ServiceException
              | Lambda.TooManyRequestsException
              | CommonAwsError
              | any,
          ) =>
            e._tag === "InternalFailure" ||
            e._tag === "RequestExpired" ||
            e._tag === "ServiceException" ||
            e._tag === "ServiceUnavailable" ||
            e._tag === "ThrottlingException" ||
            e._tag === "TooManyRequestsException",
          schedule: Schedule.exponential(100),
        });

        const mappings = yield* lambda
          .listEventSourceMappings({
            FunctionName: functionName,
            Marker: marker,
          })
          .pipe(retry, Effect.orDie);
        const mapping = mappings.EventSourceMappings?.find(
          (mapping) => mapping.EventSourceArn === stream.attr.streamArn,
        );
        if (mapping?.EventSourceArn) {
          const { Tags } = yield* lambda
            .listTags({
              Resource: `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${mapping.UUID!}`,
            })
            .pipe(retry, Effect.orDie);
          if (hasTags(yield* createInternalTags(stream.id), Tags)) {
            return mapping;
          }
          return undefined;
        }
        if (mappings.NextMarker) {
          return yield* findEventSourceMapping(
            stream,
            functionName,
            mappings.NextMarker,
          );
        }
        return undefined;
      });

      return {
        attach: ({ source: stream, attr }) => ({
          uuid: attr?.uuid ?? undefined!,
          policyStatements: [
            {
              Sid: "AWS.Kinesis.Consume",
              Effect: "Allow" as const,
              Action: [
                "kinesis:GetRecords",
                "kinesis:GetShardIterator",
                "kinesis:DescribeStream",
                "kinesis:DescribeStreamSummary",
                "kinesis:ListShards",
                "kinesis:ListStreams",
                "kinesis:SubscribeToShard",
              ],
              Resource: [stream.attr.streamArn],
            },
          ],
        }),
        postattach: Effect.fn(function* ({
          source: stream,
          props: {
            batchSize,
            maxBatchingWindow,
            startingPosition,
            startingPositionTimestamp,
            parallelizationFactor,
            bisectBatchOnFunctionError,
            maximumRecordAgeInSeconds,
            maximumRetryAttempts,
            tumblingWindowInSeconds,
            scalingConfig,
          } = {},
          attr,
          target: {
            attr: { functionName },
          },
        }) {
          const config:
            | Lambda.CreateEventSourceMappingRequest
            | Lambda.UpdateEventSourceMappingRequest = {
            FunctionName: functionName,
            EventSourceArn: stream.attr.streamArn,
            BatchSize: batchSize ?? 100,
            MaximumBatchingWindowInSeconds: maxBatchingWindow,
            StartingPosition: startingPosition ?? "TRIM_HORIZON",
            StartingPositionTimestamp: startingPositionTimestamp,
            ParallelizationFactor: parallelizationFactor,
            BisectBatchOnFunctionError: bisectBatchOnFunctionError,
            MaximumRecordAgeInSeconds: maximumRecordAgeInSeconds,
            MaximumRetryAttempts: maximumRetryAttempts,
            TumblingWindowInSeconds: tumblingWindowInSeconds,
            ScalingConfig: scalingConfig,
            Enabled: true,
            FunctionResponseTypes: ["ReportBatchItemFailures"],
            MetricsConfig: { Metrics: ["EventCount"] },
            Tags: yield* createInternalTags(stream.id),
          };

          const findOrDie = findEventSourceMapping(stream, functionName).pipe(
            Effect.flatMap((mapping) =>
              mapping
                ? Effect.succeed(mapping)
                : Effect.die(
                    new Error(
                      `StreamEventSource(${stream.id}) not found on function ${functionName}`,
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
              while: (e) =>
                e.name === "InvalidParameterValueException" &&
                e.message?.includes(
                  "The function execution role does not have permissions to call",
                ),
              schedule: Schedule.exponential(100),
            }),
            Effect.orDie,
          );
          return {
            ...attr,
            uuid: eventSourceMapping.UUID!,
          };
        }),
        detach: Effect.fn(function* ({
          source: stream,
          target: {
            attr: { functionName },
          },
          attr,
        }) {
          const uuid =
            attr?.uuid ??
            (yield* findEventSourceMapping(stream, functionName))?.UUID;
          if (uuid) {
            yield* lambda
              .deleteEventSourceMapping({
                UUID: uuid,
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }
        }),
      };
    }),
  );
