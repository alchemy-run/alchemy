import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";
import { DescribeTasks, type DescribeTasksRequest } from "./DescribeTasks.ts";
import { isTask } from "./Task.ts";

export const DescribeTasksHttp = Layer.effect(
  DescribeTasks,
  Effect.gen(function* () {
    const describeTasks = yield* ECS.describeTasks;

    return Effect.fn(function* (cluster: Cluster) {
      const ClusterArn = yield* cluster.clusterArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, AWS.ECS.DescribeTasks(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["ecs:DescribeTasks"],
                // `ecs:DescribeTasks` authorizes against the task resource:
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
      return Effect.fn(`AWS.ECS.DescribeTasks(${cluster.LogicalId})`)(
        function* (request: DescribeTasksRequest) {
          const clusterArn = yield* ClusterArn;
          return yield* describeTasks({
            ...request,
            cluster: clusterArn,
          });
        },
      );
    });
  }),
);
