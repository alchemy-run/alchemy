import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface StopTaskRequest extends Omit<ECS.StopTaskRequest, "cluster"> {}

/** @binding */
export interface StopTask extends Binding.Service<
  StopTask,
  "AWS.ECS.StopTask",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: StopTaskRequest,
    ) => Effect.Effect<ECS.StopTaskResponse, ECS.StopTaskError>
  >
> {}
export const StopTask = Binding.Service<StopTask>("AWS.ECS.StopTask");
