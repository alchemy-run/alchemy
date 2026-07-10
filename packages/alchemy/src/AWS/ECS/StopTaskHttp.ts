import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";
import { StopTask, type StopTaskRequest } from "./StopTask.ts";
import { isTask } from "./Task.ts";

export const StopTaskHttp = Layer.effect(
  StopTask,
  Effect.gen(function* () {
    const stopTask = yield* ECS.stopTask;

    return Effect.fn(function* (cluster: Cluster) {
      const ClusterArn = yield* cluster.clusterArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, AWS.ECS.StopTask(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["ecs:StopTask"],
                // `ecs:StopTask` authorizes against the task resource:
                // arn:aws:ecs:{region}:{account}:task/{clusterName}/*
                Resource: [
                  Output.map(
                    cluster.clusterArn,
                    (arn) => `${arn.replace(":cluster/", ":task/")}/*`,
                  ),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.ECS.StopTask(${cluster.LogicalId})`)(function* (
        request: StopTaskRequest,
      ) {
        const clusterArn = yield* ClusterArn;
        return yield* stopTask({
          ...request,
          cluster: clusterArn,
        });
      });
    });
  }),
);
