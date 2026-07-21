import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsTaskLaunchHttpBinding } from "./BindingHttp.ts";
import { StartTask, StartTaskRequiresCluster } from "./StartTask.ts";

export const StartTaskHttp = Layer.effect(
  StartTask,
  makeEcsTaskLaunchHttpBinding({
    tag: "AWS.ECS.StartTask",
    operation: ECS.startTask,
    actions: ["ecs:StartTask"],
    missingClusterError: (task) =>
      new StartTaskRequiresCluster({
        task: task.LogicalId,
        message:
          `Task '${task.LogicalId}' does not declare a cluster. Either ` +
          "declare `cluster` on the Task's props or pass the cluster " +
          "explicitly: StartTask(cluster, task).",
      }),
  }),
);
