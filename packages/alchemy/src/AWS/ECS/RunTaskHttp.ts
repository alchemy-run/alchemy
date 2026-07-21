import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsTaskLaunchHttpBinding } from "./BindingHttp.ts";
import { RunTask, RunTaskRequiresCluster } from "./RunTask.ts";

export const RunTaskHttp = Layer.effect(
  RunTask,
  makeEcsTaskLaunchHttpBinding({
    tag: "AWS.ECS.RunTask",
    operation: ECS.runTask,
    actions: ["ecs:RunTask"],
    missingClusterError: (task) =>
      new RunTaskRequiresCluster({
        task: task.LogicalId,
        message:
          `Task '${task.LogicalId}' does not declare a cluster. Either ` +
          "declare `cluster` on the Task's props or pass the cluster " +
          "explicitly: RunTask(cluster, task).",
      }),
  }),
);
