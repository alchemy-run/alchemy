import { Task } from "@/AWS/ECS/Task.ts";
import * as Effect from "effect/Effect";

/**
 * A minimal one-shot Fargate task for the ECS task-control binding tests
 * (`RunTask` / `StopTask` / `DescribeTasks` / `ListTasks`).
 *
 * The `docker.dockerfile` override replaces Alchemy's generated Dockerfile
 * with a tiny busybox image whose default command echoes a marker and exits 0
 * — the bundled program is never executed. Tests that need a long-running
 * task (e.g. StopTask) override the command at `runTask` time via
 * `overrides.containerOverrides` (which replaces the image CMD).
 */
export default class OneShotTask extends Task<OneShotTask>()(
  "EcsBindingsOneShotTask",
  {
    main: import.meta.filename,
    cpu: 256,
    memory: 512,
    taskName: "alchemy-test-ecs-bindings-oneshot",
    docker: {
      dockerfile: [
        // Docker Hub busybox: the public.ecr.aws mirror aggressively
        // rate-limits anonymous pulls during local builds (see fixtures/task.ts).
        "FROM busybox:stable",
        'CMD ["sh", "-c", "echo alchemy-ecs-bindings-oneshot"]',
        "",
      ].join("\n"),
    },
  },
  // The container never runs the bundled program (see the Dockerfile above),
  // so the program is a no-op.
  Effect.gen(function* () {}),
) {}
