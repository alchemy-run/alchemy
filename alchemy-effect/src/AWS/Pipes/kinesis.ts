import type * as pipes from "@distilled.cloud/aws/pipes";
import * as Effect from "effect/Effect";
import * as IAM from "../IAM/index.ts";
import type { EventBus } from "../EventBridge/EventBus.ts";
import type { Stream } from "../Kinesis/Stream.ts";
import type { Function } from "../Lambda/Function.ts";
import type { Queue } from "../SQS/Queue.ts";
import { Pipe } from "./Pipe.ts";

export interface KinesisSourceProps extends Omit<
  pipes.PipeSourceKinesisStreamParameters,
  "StartingPosition"
> {
  startingPosition?: pipes.PipeSourceKinesisStreamParameters["StartingPosition"];
}

export interface LambdaEnrichmentProps {
  inputTemplate?: string;
}

export interface LambdaTargetProps {
  inputTemplate?: string;
  invocationType?: string;
}

export interface QueueTargetProps {
  inputTemplate?: string;
  sqs?: pipes.PipeTargetSqsQueueParameters;
}

export interface EventBusTargetProps {
  inputTemplate?: string;
  event?: pipes.PipeTargetEventBridgeEventBusParameters;
}

export const kinesis = (stream: Stream, props: KinesisSourceProps = {}) => {
  const sourceParameters: pipes.PipeSourceParameters = {
    KinesisStreamParameters: {
      BatchSize: props.BatchSize,
      DeadLetterConfig: props.DeadLetterConfig,
      OnPartialBatchItemFailure: props.OnPartialBatchItemFailure,
      MaximumBatchingWindowInSeconds: props.MaximumBatchingWindowInSeconds,
      MaximumRecordAgeInSeconds: props.MaximumRecordAgeInSeconds,
      MaximumRetryAttempts: props.MaximumRetryAttempts,
      ParallelizationFactor: props.ParallelizationFactor,
      StartingPosition: props.startingPosition ?? "LATEST",
      StartingPositionTimestamp: props.StartingPositionTimestamp,
    },
  };

  return makeKinesisBuilder(stream, sourceParameters);
};

const makeKinesisBuilder = (
  stream: Stream,
  sourceParameters: pipes.PipeSourceParameters,
  enrichment?: {
    fn: Function;
    props: LambdaEnrichmentProps;
  },
) => ({
  filter: (pattern: unknown) =>
    makeKinesisBuilder(
      stream,
      {
        ...sourceParameters,
        FilterCriteria: {
          Filters: [
            {
              Pattern: JSON.stringify(pattern),
            },
          ],
        },
      },
      enrichment,
    ),

  enrich: (fn: Function, props: LambdaEnrichmentProps = {}) =>
    makeKinesisBuilder(stream, sourceParameters, { fn, props }),

  toLambda: (fn: Function, props: LambdaTargetProps = {}) =>
    Effect.gen(function* () {
      const pipeId = enrichment
        ? `${stream.LogicalId}Via${enrichment.fn.LogicalId}To${fn.LogicalId}Pipe`
        : `${stream.LogicalId}To${fn.LogicalId}Pipe`;

      const role = yield* IAM.Role(`${pipeId}Role`, {
        assumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: "pipes.amazonaws.com",
              },
              Action: ["sts:AssumeRole"],
              Resource: ["*"],
            },
          ],
        },
        inlinePolicies: {
          PipeAccess: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "kinesis:DescribeStream",
                  "kinesis:GetRecords",
                  "kinesis:GetShardIterator",
                  "kinesis:ListShards",
                ],
                Resource: [stream.streamArn],
              },
              ...(enrichment
                ? [
                    {
                      Effect: "Allow",
                      Action: ["lambda:InvokeFunction"],
                      Resource: [enrichment.fn.functionArn],
                    },
                  ]
                : []),
              {
                Effect: "Allow",
                Action: ["lambda:InvokeFunction"],
                Resource: [fn.functionArn],
              },
            ],
          },
        },
      });

      return yield* Pipe(pipeId, {
        source: stream.streamArn as any,
        sourceParameters,
        enrichment: enrichment?.fn.functionArn as any,
        enrichmentParameters: enrichment
          ? {
              InputTemplate: enrichment.props.inputTemplate,
            }
          : undefined,
        target: fn.functionArn as any,
        targetParameters: {
          InputTemplate: props.inputTemplate,
          LambdaFunctionParameters: {
            InvocationType: props.invocationType,
          },
        },
        roleArn: role.roleArn,
      });
    }),

  toQueue: (queue: Queue, props: QueueTargetProps = {}) =>
    Effect.gen(function* () {
      const pipeId = enrichment
        ? `${stream.LogicalId}Via${enrichment.fn.LogicalId}To${queue.LogicalId}Pipe`
        : `${stream.LogicalId}To${queue.LogicalId}Pipe`;

      const role = yield* IAM.Role(`${pipeId}Role`, {
        assumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: "pipes.amazonaws.com",
              },
              Action: ["sts:AssumeRole"],
              Resource: ["*"],
            },
          ],
        },
        inlinePolicies: {
          PipeAccess: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "kinesis:DescribeStream",
                  "kinesis:GetRecords",
                  "kinesis:GetShardIterator",
                  "kinesis:ListShards",
                ],
                Resource: [stream.streamArn],
              },
              ...(enrichment
                ? [
                    {
                      Effect: "Allow",
                      Action: ["lambda:InvokeFunction"],
                      Resource: [enrichment.fn.functionArn],
                    },
                  ]
                : []),
              {
                Effect: "Allow",
                Action: ["sqs:SendMessage"],
                Resource: [queue.queueArn],
              },
            ],
          },
        },
      });

      return yield* Pipe(pipeId, {
        source: stream.streamArn as any,
        sourceParameters,
        enrichment: enrichment?.fn.functionArn as any,
        enrichmentParameters: enrichment
          ? {
              InputTemplate: enrichment.props.inputTemplate,
            }
          : undefined,
        target: queue.queueArn as any,
        targetParameters: {
          InputTemplate: props.inputTemplate,
          SqsQueueParameters: props.sqs,
        },
        roleArn: role.roleArn,
      });
    }),

  toEventBus: (bus: EventBus, props: EventBusTargetProps = {}) =>
    Effect.gen(function* () {
      const pipeId = enrichment
        ? `${stream.LogicalId}Via${enrichment.fn.LogicalId}To${bus.LogicalId}Pipe`
        : `${stream.LogicalId}To${bus.LogicalId}Pipe`;

      const role = yield* IAM.Role(`${pipeId}Role`, {
        assumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: "pipes.amazonaws.com",
              },
              Action: ["sts:AssumeRole"],
              Resource: ["*"],
            },
          ],
        },
        inlinePolicies: {
          PipeAccess: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "kinesis:DescribeStream",
                  "kinesis:GetRecords",
                  "kinesis:GetShardIterator",
                  "kinesis:ListShards",
                ],
                Resource: [stream.streamArn],
              },
              ...(enrichment
                ? [
                    {
                      Effect: "Allow",
                      Action: ["lambda:InvokeFunction"],
                      Resource: [enrichment.fn.functionArn],
                    },
                  ]
                : []),
              {
                Effect: "Allow",
                Action: ["events:PutEvents"],
                Resource: [bus.eventBusArn],
              },
            ],
          },
        },
      });

      return yield* Pipe(pipeId, {
        source: stream.streamArn as any,
        sourceParameters,
        enrichment: enrichment?.fn.functionArn as any,
        enrichmentParameters: enrichment
          ? {
              InputTemplate: enrichment.props.inputTemplate,
            }
          : undefined,
        target: bus.eventBusArn as any,
        targetParameters: {
          InputTemplate: props.inputTemplate,
          EventBridgeEventBusParameters: props.event,
        },
        roleArn: role.roleArn,
      });
    }),
});
