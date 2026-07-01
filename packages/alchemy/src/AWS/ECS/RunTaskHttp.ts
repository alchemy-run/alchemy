import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { isTask, type Task } from "./Task.ts";
import type { Cluster } from "./Cluster.ts";
import { RunTask, type RunTaskRequest } from "./RunTask.ts";

export const RunTaskHttp = Layer.effect(
  RunTask,
  Effect.gen(function* () {
    const runTask = yield* ECS.runTask;

    return Effect.fn(function* (cluster: Cluster, task: Task) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, AWS.ECS.RunTask(${cluster}, ${task}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["ecs:RunTask"],
                  Resource: [task.taskDefinitionArn],
                },
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [task.taskRoleArn, task.executionRoleArn],
                },
                {
                  Effect: "Allow",
                  Action: ["ecs:DescribeTasks"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      const clusterArn = (yield* cluster.clusterArn) as unknown as string;
      const taskDefinitionArn =
        (yield* task.taskDefinitionArn) as unknown as string;

      return Effect.fn(
        `AWS.ECS.RunTask(${cluster.LogicalId}, ${task.LogicalId})`,
      )(function* (request: RunTaskRequest) {
        return yield* runTask({
          ...request,
          cluster: clusterArn,
          taskDefinition: taskDefinitionArn,
        });
      });
    });
  }),
);
