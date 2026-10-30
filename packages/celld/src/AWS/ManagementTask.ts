/**
 * The fleet's management runner as an ECS task: a Fargate container inside
 * the fleet VPC (the only place the nodes' private operator listener is
 * reachable) that drains the management queue. Unlike a VPC Lambda, its
 * network interface is released as soon as the task stops, so tearing a
 * fleet down never waits on lingering ENIs.
 */
import { Task } from "@alchemy.run/aws/ECS/Task";
import * as Effect from "effect/Effect";
import { runManagementQueue } from "./ManagementQueue.ts";
import { ManagementRunnerHttp } from "./ManagementRunner.ts";

export class ManagementTask extends Task<ManagementTask>()("ManagementRunner") {}

export default ManagementTask.make(
  {
    main: import.meta.url,
    cpu: 256,
    memory: 512,
    runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
  },
  Effect.gen(function* () {
    return {
      run: runManagementQueue.pipe(Effect.provide(ManagementRunnerHttp)),
    };
  }),
);
