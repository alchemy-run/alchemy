import * as AWS from "@alchemy.run/aws";
import { Cluster } from "@alchemy.run/aws/ECS/Cluster";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../../EnvValues.ts";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";
import EnvTaskLive, { ENV_MARKER, EnvTask } from "./fixtures/env-task.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const Stack = Alchemy.Stack(
  "AlchemyEcsEnvStack",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    const cluster = yield* Cluster("EnvCluster", {});
    const task = yield* EnvTask;
    return {
      clusterArn: cluster.clusterArn,
      taskDefinitionArn: task.taskDefinitionArn,
      logGroupName: task.logGroupName,
    };
  }).pipe(Effect.provide(EnvTaskLive)),
);

// Docker build + ECR push + roles.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

test.provider.skipIf(!!process.env.FAST)(
  "ECS task reads every env value as the expected string",
  () =>
    Effect.gen(function* () {
      const { clusterArn, taskDefinitionArn, logGroupName } = yield* stack;

      // A public subnet + public IP lets the task ENI pull from ECR.
      const { subnetIds } = yield* getDefaultVpcNetwork;
      const started = yield* ecs
        .runTask({
          cluster: clusterArn,
          taskDefinition: taskDefinitionArn!,
          launchType: "FARGATE",
          count: 1,
          startedBy: "alchemy-env-test",
          networkConfiguration: {
            awsvpcConfiguration: { subnets: [subnetIds[0]!], assignPublicIp: "ENABLED" },
          },
        })
        .pipe(
          Effect.retry({
            while: (e) =>
              e._tag === "ClientException" &&
              (e.message ?? "").includes("unable to assume the role"),
            schedule: Schedule.spaced("5 seconds"),
            times: 12,
          }),
        );
      expect(started.failures ?? []).toEqual([]);
      const taskArn = started.tasks?.[0]?.taskArn!;

      const stopped = yield* ecs.describeTasks({ cluster: clusterArn, tasks: [taskArn] }).pipe(
        Effect.map((r) => r.tasks?.[0]),
        Effect.repeat({
          schedule: Schedule.spaced("6 seconds"),
          until: (t) => t?.lastStatus === "STOPPED",
          times: 40,
        }),
      );
      expect(stopped?.stoppedReason ?? "").not.toContain("CannotPullContainer");
      expect(stopped?.containers?.[0]?.exitCode).toBe(0);

      // awslogs stream name ends with the task id; log delivery lags the stop.
      const taskId = taskArn.split("/").at(-1)!;
      const line = yield* logs.filterLogEvents({ logGroupName: logGroupName! }).pipe(
        Effect.map(
          (r) =>
            (r.events ?? []).find(
              (e) => e.logStreamName?.endsWith(taskId) && e.message?.startsWith(ENV_MARKER),
            )?.message,
        ),
        Effect.flatMap((m) =>
          m ? Effect.succeed(m) : Effect.fail(new Error("env line not logged yet")),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
      );
      expect(JSON.parse(line.slice(ENV_MARKER.length))).toEqual(expectedEnv);
    }),
  { tags: ["provider:aws", "provider:aws:ecs", "live"], timeout: 420_000 },
);
