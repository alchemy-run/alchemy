/**
 * The management runner as a Fargate task inside the fleet's network,
 * reached through a queue. A task's network interface is released as soon as
 * it stops, so destroying the fleet never waits on lingering ENIs.
 */
import * as ECS from "@alchemy.run/aws/ECS";
import * as SQS from "@alchemy.run/aws/SQS";
import * as Output from "alchemy/Output";
import type { StackServices } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { CELLD_PUBLIC_PORT } from "../CelldCli.ts";
import { ecsAwsEnvironment } from "./EcsEnvironment.ts";
import {
  EcsManagement,
  MANAGEMENT_PREFIX,
  type EcsManagementFleet,
  type EcsManagementService,
} from "./EcsManagement.ts";
import { makeQueueTransport } from "./ManagementQueue.ts";
import {
  makeManagementClient,
  managementStorePolicy,
  type ManagementTransport,
} from "./ManagementRunner.ts";
import ManagementTaskLive, { ManagementTask } from "./ManagementTask.ts";

export interface EcsTaskManagementOptions {
  /**
   * Seconds without work after which the runner stops. The next deploy that
   * needs it starts a new one.
   * @default 300
   */
  readonly idleSeconds?: number;
}

const composeQueuedRunner = (hosting: "task" | "service", idleSeconds: number) =>
  Effect.fn(function* (fleet: EcsManagementFleet) {
    const queue = yield* SQS.Queue("ManagementQueue", {
      visibilityTimeout: "2 minutes",
      messageRetentionPeriod: "5 minutes",
      receiveMessageWaitTime: "20 seconds",
    });
    const task = yield* ManagementTask.pipe(Effect.provide(ManagementTaskLive));
    const managementArn = Output.interpolate`arn:${fleet.partition}:s3:::${fleet.bucketName}/${MANAGEMENT_PREFIX}/*`;
    yield* task.bind("CelldManagement", {
      env: {
        CELLD_MANAGEMENT_BUCKET: fleet.bucketName,
        CELLD_MANAGEMENT_MINIMUM_NODES: String(fleet.minimumNodes),
        CELLD_MANAGEMENT_QUEUE_URL: queue.queueUrl,
        CELLD_MANAGEMENT_IDLE_SECONDS: String(hosting === "task" ? idleSeconds : 0),
      },
      policyStatements: [
        ...managementStorePolicy(fleet.partition, fleet.bucketName),
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject"],
          Resource: [managementArn],
        },
        {
          Effect: "Allow",
          Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
          Resource: [queue.queueArn],
        },
      ],
    });
    if (hosting === "service") {
      yield* ECS.Service("ManagementService", {
        cluster: fleet.cluster,
        task: {
          taskDefinitionArn: task.taskDefinitionArn,
          containerName: task.containerName,
          // The runner serves no traffic; the port only matters to load balancers.
          port: CELLD_PUBLIC_PORT,
        },
        desiredCount: 1,
        launchType: "FARGATE",
        vpcId: fleet.vpcId,
        subnets: fleet.subnetIds,
        securityGroups: [fleet.securityGroupId],
        assignPublicIp: true,
        tags: fleet.tags,
      });
    }
    // A Fargate runner takes a public IP in the node subnets, like the nodes
    // themselves: it needs no private S3 route.
    return {
      managementSubnetIds: fleet.subnetIds,
      managementQueue: {
        queueUrl: queue.queueUrl,
        ...(hosting === "task"
          ? {
              launch: {
                clusterArn: fleet.cluster.clusterArn,
                taskDefinitionArn: task.taskDefinitionArn,
                subnetIds: fleet.subnetIds,
                securityGroupIds: [fleet.securityGroupId],
              },
            }
          : {}),
      },
    };
  });

/** The on-demand task runner over a given queue transport. */
export const makeEcsTaskManagement = (
  options: EcsTaskManagementOptions,
  transport: ManagementTransport,
): EcsManagementService => ({
  compose: composeQueuedRunner("task", options.idleSeconds ?? 300),
  client: makeManagementClient(() => Effect.succeed(transport)),
});

/** The always-on service runner over a given queue transport. */
export const makeEcsServiceManagement = (transport: ManagementTransport): EcsManagementService => ({
  compose: composeQueuedRunner("service", 0),
  client: makeManagementClient(() => Effect.succeed(transport)),
});

const queuedManagement = (make: (transport: ManagementTransport) => EcsManagementService) =>
  Layer.effect(EcsManagement, makeQueueTransport.pipe(Effect.map(make))).pipe(
    Layer.provide(Layer.mergeAll(ecsAwsEnvironment, FetchHttpClient.layer)),
    Layer.orDie,
  );

/**
 * Host an {@link EcsFleet}'s management runner as an on-demand Fargate task.
 * Nothing runs between deploys: a deploy's first management call (activation,
 * reload, D1 migrations) starts the task and waits for it, typically about a
 * minute; later calls reuse it until it has been idle for `idleSeconds`. It is
 * billed only while running, and destroying the fleet takes a few minutes.
 *
 * ### Hosting the Runner
 * **Example:** Start the runner on demand
 * ```typescript
 * const host = CelldAWS.EcsFleet().pipe(Layer.provide(CelldAWS.EcsTaskManagement()));
 * ```
 *
 * **Example:** Keep an on-demand runner up longer between calls
 * ```typescript
 * const host = CelldAWS.EcsFleet().pipe(
 *   Layer.provide(CelldAWS.EcsTaskManagement({ idleSeconds: 900 })),
 * );
 * ```
 *
 * @layer
 * @provides CelldAWS.EcsManagement
 * @product Celld
 */
export const EcsTaskManagement = (
  options: EcsTaskManagementOptions = {},
): Layer.Layer<EcsManagement, never, StackServices> =>
  queuedManagement((transport) => makeEcsTaskManagement(options, transport));

/**
 * Host an {@link EcsFleet}'s management runner as an always-on Fargate task,
 * kept running by an ECS service, so management calls never wait for one to
 * start. The runner (0.25 vCPU, 0.5 GB, ARM) and its public IPv4 address cost
 * about $11 a month in us-east-1.
 *
 * ### Hosting the Runner
 * **Example:** Keep the runner running
 * ```typescript
 * const host = CelldAWS.EcsFleet().pipe(Layer.provide(CelldAWS.EcsServiceManagement()));
 * ```
 *
 * @layer
 * @provides CelldAWS.EcsManagement
 * @product Celld
 */
export const EcsServiceManagement = (): Layer.Layer<EcsManagement, never, StackServices> =>
  queuedManagement(makeEcsServiceManagement);
