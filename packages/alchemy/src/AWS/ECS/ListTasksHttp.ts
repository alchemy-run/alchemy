import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";
import { ListTasks, type ListTasksRequest } from "./ListTasks.ts";
import { isTask } from "./Task.ts";

export const ListTasksHttp = Layer.effect(
  ListTasks,
  Effect.gen(function* () {
    const listTasks = yield* ECS.listTasks;

    return Effect.fn(function* (cluster: Cluster) {
      const ClusterArn = yield* cluster.clusterArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, AWS.ECS.ListTasks(${cluster}))`({
            policyStatements: [
              {
                // `ecs:ListTasks` has no useful resource-level scoping on
                // Fargate (its resource type is container-instance), so grant
                // `*` conditioned on the bound cluster.
                Effect: "Allow",
                Action: ["ecs:ListTasks"],
                Resource: ["*"],
                Condition: {
                  ArnEquals: { "ecs:cluster": cluster.clusterArn },
                },
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.ECS.ListTasks(${cluster.LogicalId})`)(function* (
        request: ListTasksRequest,
      ) {
        const clusterArn = yield* ClusterArn;
        return yield* listTasks({
          ...request,
          cluster: clusterArn,
        });
      });
    });
  }),
);
