import type * as pipes from "@distilled.cloud/aws/pipes";
import * as Effect from "effect/Effect";
import * as IAM from "../IAM/index.ts";
import type { EventBus } from "../EventBridge/EventBus.ts";
import type { Function } from "../Lambda/Function.ts";
import type { Queue } from "../SQS/Queue.ts";
import { Pipe } from "./Pipe.ts";

export interface QueueSourceProps extends pipes.PipeSourceSqsQueueParameters {}

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

export const sqs = (queue: Queue, props: QueueSourceProps = {}) => {
  const sourceParameters: pipes.PipeSourceParameters = {
    SqsQueueParameters: {
      BatchSize: props.BatchSize,
      MaximumBatchingWindowInSeconds: props.MaximumBatchingWindowInSeconds,
    },
  };

  return makeSqsBuilder(queue, sourceParameters);
};

const makeSqsBuilder = (
  queue: Queue,
  sourceParameters: pipes.PipeSourceParameters,
  enrichment?: {
    fn: Function;
    props: LambdaEnrichmentProps;
  },
) => ({
  filter: (pattern: unknown) =>
    makeSqsBuilder(
      queue,
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
    makeSqsBuilder(queue, sourceParameters, { fn, props }),

  toLambda: (fn: Function, props: LambdaTargetProps = {}) =>
    Effect.gen(function* () {
      const pipeId = enrichment
        ? `${queue.LogicalId}Via${enrichment.fn.LogicalId}To${fn.LogicalId}Pipe`
        : `${queue.LogicalId}To${fn.LogicalId}Pipe`;

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
                  "sqs:ReceiveMessage",
                  "sqs:DeleteMessage",
                  "sqs:GetQueueAttributes",
                  "sqs:ChangeMessageVisibility",
                ],
                Resource: [queue.queueArn],
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
        source: queue.queueArn as any,
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

  toQueue: (targetQueue: Queue, props: QueueTargetProps = {}) =>
    Effect.gen(function* () {
      const pipeId = enrichment
        ? `${queue.LogicalId}Via${enrichment.fn.LogicalId}To${targetQueue.LogicalId}Pipe`
        : `${queue.LogicalId}To${targetQueue.LogicalId}Pipe`;

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
                  "sqs:ReceiveMessage",
                  "sqs:DeleteMessage",
                  "sqs:GetQueueAttributes",
                  "sqs:ChangeMessageVisibility",
                ],
                Resource: [queue.queueArn],
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
                Resource: [targetQueue.queueArn],
              },
            ],
          },
        },
      });

      return yield* Pipe(pipeId, {
        source: queue.queueArn as any,
        sourceParameters,
        enrichment: enrichment?.fn.functionArn as any,
        enrichmentParameters: enrichment
          ? {
              InputTemplate: enrichment.props.inputTemplate,
            }
          : undefined,
        target: targetQueue.queueArn as any,
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
        ? `${queue.LogicalId}Via${enrichment.fn.LogicalId}To${bus.LogicalId}Pipe`
        : `${queue.LogicalId}To${bus.LogicalId}Pipe`;

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
                  "sqs:ReceiveMessage",
                  "sqs:DeleteMessage",
                  "sqs:GetQueueAttributes",
                  "sqs:ChangeMessageVisibility",
                ],
                Resource: [queue.queueArn],
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
        source: queue.queueArn as any,
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
