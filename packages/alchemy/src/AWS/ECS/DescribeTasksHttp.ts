import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { isTask } from "./Task.ts";
import type { Cluster } from "./Cluster.ts";
import { DescribeTasks, type DescribeTasksRequest } from "./DescribeTasks.ts";

export const DescribeTasksHttp = Layer.effect(
  DescribeTasks,
  Effect.gen(function* () {
    const describeTasks = yield* ECS.describeTasks;

    return Effect.fn(function* (cluster: Cluster) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, AWS.ECS.DescribeTasks(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["ecs:DescribeTasks"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      const clusterArn = (yield* cluster.clusterArn) as unknown as string;
      return Effect.fn(`AWS.ECS.DescribeTasks(${cluster.LogicalId})`)(
        function* (request: DescribeTasksRequest) {
          return yield* describeTasks({
            ...request,
            cluster: clusterArn,
          });
        },
      );
    });
  }),
);
