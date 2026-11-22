import * as app from "@distilled.cloud/azure/app";
import * as Layer from "effect/Layer";
import { makeJobActionBinding, ContainerAppsRole } from "./BindingHttp.ts";
import { SuspendJob } from "./SuspendJob.ts";

/**
 * Implementation of {@link SuspendJob} over the distilled `app` ARM
 * operation `SuspendJob`. Assigns the custom `AzureContainerAppsJobSuspendRole` on the
 * job.
 *
 * @layer
 * @provides Azure.ContainerApps.SuspendJob
 */
export const SuspendJobHttp = Layer.effect(
  SuspendJob,
  makeJobActionBinding({
    tag: "Azure.ContainerApps.SuspendJob",
    operation: app.SuspendJob,
    grant: ContainerAppsRole.JobSuspend,
  }),
);
