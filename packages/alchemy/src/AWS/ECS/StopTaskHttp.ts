import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { isTask } from "./Task.ts";
import type { Cluster } from "./Cluster.ts";
import { StopTask, type StopTaskRequest } from "./StopTask.ts";

export const StopTaskHttp = Layer.effect(
  StopTask,
  Effect.gen(function* () {
    const stopTask = yield* ECS.stopTask;

    return Effect.fn(function* (cluster: Cluster) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, AWS.ECS.StopTask(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["ecs:StopTask"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      const clusterArn = (yield* cluster.clusterArn) as unknown as string;
      return Effect.fn(`AWS.ECS.StopTask(${cluster.LogicalId})`)(function* (
        request: StopTaskRequest,
      ) {
        return yield* stopTask({
          ...request,
          cluster: clusterArn,
        });
      });
    });
  }),
);
