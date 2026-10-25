import * as app from "@distilled.cloud/azure/app";
import * as Layer from "effect/Layer";
import { makeJobActionBinding, ContainerAppsRole } from "./BindingHttp.ts";
import { StartJob } from "./StartJob.ts";

/**
 * Implementation of {@link StartJob} over the distilled `app` ARM
 * operation `StartJob`. Assigns the custom `AzureContainerAppsJobStartRole` on the
 * job.
 *
 * @layer
 * @provides Azure.ContainerApps.StartJob
 */
export const StartJobHttp = Layer.effect(
  StartJob,
  makeJobActionBinding({
    tag: "Azure.ContainerApps.StartJob",
    operation: app.StartJob,
    grant: ContainerAppsRole.JobStart,
  }),
);
