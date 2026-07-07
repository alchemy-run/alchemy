import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { isTask } from "./Task.ts";
import type { Cluster } from "./Cluster.ts";
import { ListTasks, type ListTasksRequest } from "./ListTasks.ts";

export const ListTasksHttp = Layer.effect(
  ListTasks,
  Effect.gen(function* () {
    const listTasks = yield* ECS.listTasks;

    return Effect.fn(function* (cluster: Cluster) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, AWS.ECS.ListTasks(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["ecs:ListTasks"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      const clusterArn = (yield* cluster.clusterArn) as unknown as string;
      return Effect.fn(`AWS.ECS.ListTasks(${cluster.LogicalId})`)(function* (
        request: ListTasksRequest,
      ) {
        return yield* listTasks({
          ...request,
          cluster: clusterArn,
        });
      });
    });
  }),
);
