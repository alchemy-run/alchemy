import type * as pipes from "@distilled.cloud/aws/pipes";
import * as Effect from "effect/Effect";
import * as IAM from "../IAM/index.ts";
import type { Table } from "../DynamoDB/Table.ts";
import type { EventBus } from "../EventBridge/EventBus.ts";
import type { Function } from "../Lambda/Function.ts";
import type { Queue } from "../SQS/Queue.ts";
import { Pipe } from "./Pipe.ts";

export interface DynamoDBSourceProps extends Omit<
  pipes.PipeSourceDynamoDBStreamParameters,
  "StartingPosition"
> {
  startingPosition?: pipes.PipeSourceDynamoDBStreamParameters["StartingPosition"];
  streamViewType?:
    | "KEYS_ONLY"
    | "NEW_IMAGE"
    | "OLD_IMAGE"
    | "NEW_AND_OLD_IMAGES";
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

export const dynamodb = (table: Table, props: DynamoDBSourceProps = {}) => {
  const sourceParameters: pipes.PipeSourceParameters = {
    DynamoDBStreamParameters: {
      BatchSize: props.BatchSize,
      DeadLetterConfig: props.DeadLetterConfig,
      OnPartialBatchItemFailure: props.OnPartialBatchItemFailure,
      MaximumBatchingWindowInSeconds: props.MaximumBatchingWindowInSeconds,
      MaximumRecordAgeInSeconds: props.MaximumRecordAgeInSeconds,
      MaximumRetryAttempts: props.MaximumRetryAttempts,
      ParallelizationFactor: props.ParallelizationFactor,
      StartingPosition: props.startingPosition ?? "LATEST",
    },
  };

  return makeDynamoDbBuilder(table, props, sourceParameters);
};

const makeDynamoDbBuilder = (
  table: Table,
  props: DynamoDBSourceProps,
  sourceParameters: pipes.PipeSourceParameters,
  enrichment?: {
    fn: Function;
    props: LambdaEnrichmentProps;
  },
) => ({
  filter: (pattern: unknown) =>
    makeDynamoDbBuilder(
      table,
      props,
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

  enrich: (fn: Function, enrichmentProps: LambdaEnrichmentProps = {}) =>
    makeDynamoDbBuilder(table, props, sourceParameters, {
      fn,
      props: enrichmentProps,
    }),

  toLambda: (fn: Function, targetProps: LambdaTargetProps = {}) =>
    Effect.gen(function* () {
      yield* table.bind`AWS.DynamoDB.Streams(${table})`({
        streamSpecification: {
          StreamEnabled: true,
          StreamViewType: props.streamViewType ?? "NEW_AND_OLD_IMAGES",
        },
      });

      const pipeId = enrichment
        ? `${table.LogicalId}Via${enrichment.fn.LogicalId}To${fn.LogicalId}Pipe`
        : `${table.LogicalId}To${fn.LogicalId}Pipe`;

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
                  "dynamodb:DescribeStream",
                  "dynamodb:GetRecords",
                  "dynamodb:GetShardIterator",
                  "dynamodb:ListStreams",
                ],
                Resource: [table.latestStreamArn],
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
        source: table.latestStreamArn as any,
        sourceParameters,
        enrichment: enrichment?.fn.functionArn as any,
        enrichmentParameters: enrichment
          ? {
              InputTemplate: enrichment.props.inputTemplate,
            }
          : undefined,
        target: fn.functionArn as any,
        targetParameters: {
          InputTemplate: targetProps.inputTemplate,
          LambdaFunctionParameters: {
            InvocationType: targetProps.invocationType,
          },
        },
        roleArn: role.roleArn,
      });
    }),

  toQueue: (queue: Queue, targetProps: QueueTargetProps = {}) =>
    Effect.gen(function* () {
      yield* table.bind`AWS.DynamoDB.Streams(${table})`({
        streamSpecification: {
          StreamEnabled: true,
          StreamViewType: props.streamViewType ?? "NEW_AND_OLD_IMAGES",
        },
      });

      const pipeId = enrichment
        ? `${table.LogicalId}Via${enrichment.fn.LogicalId}To${queue.LogicalId}Pipe`
        : `${table.LogicalId}To${queue.LogicalId}Pipe`;

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
                  "dynamodb:DescribeStream",
                  "dynamodb:GetRecords",
                  "dynamodb:GetShardIterator",
                  "dynamodb:ListStreams",
                ],
                Resource: [table.latestStreamArn],
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
        source: table.latestStreamArn as any,
        sourceParameters,
        enrichment: enrichment?.fn.functionArn as any,
        enrichmentParameters: enrichment
          ? {
              InputTemplate: enrichment.props.inputTemplate,
            }
          : undefined,
        target: queue.queueArn as any,
        targetParameters: {
          InputTemplate: targetProps.inputTemplate,
          SqsQueueParameters: targetProps.sqs,
        },
        roleArn: role.roleArn,
      });
    }),

  toEventBus: (bus: EventBus, targetProps: EventBusTargetProps = {}) =>
    Effect.gen(function* () {
      yield* table.bind`AWS.DynamoDB.Streams(${table})`({
        streamSpecification: {
          StreamEnabled: true,
          StreamViewType: props.streamViewType ?? "NEW_AND_OLD_IMAGES",
        },
      });

      const pipeId = enrichment
        ? `${table.LogicalId}Via${enrichment.fn.LogicalId}To${bus.LogicalId}Pipe`
        : `${table.LogicalId}To${bus.LogicalId}Pipe`;

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
                  "dynamodb:DescribeStream",
                  "dynamodb:GetRecords",
                  "dynamodb:GetShardIterator",
                  "dynamodb:ListStreams",
                ],
                Resource: [table.latestStreamArn],
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
        source: table.latestStreamArn as any,
        sourceParameters,
        enrichment: enrichment?.fn.functionArn as any,
        enrichmentParameters: enrichment
          ? {
              InputTemplate: enrichment.props.inputTemplate,
            }
          : undefined,
        target: bus.eventBusArn as any,
        targetParameters: {
          InputTemplate: targetProps.inputTemplate,
          EventBridgeEventBusParameters: targetProps.event,
        },
        roleArn: role.roleArn,
      });
    }),
});
