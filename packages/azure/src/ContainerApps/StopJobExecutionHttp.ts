import * as app from "@distilled.cloud/azure/app";
import * as Layer from "effect/Layer";
import { makeJobActionBinding, ContainerAppsRole } from "./BindingHttp.ts";
import { StopJobExecution } from "./StopJobExecution.ts";

/**
 * Implementation of {@link StopJobExecution} over the distilled `app` ARM
 * operation `StopJobExecution`. Assigns the custom `AzureContainerAppsJobExecutionStopRole` on the
 * job.
 *
 * @layer
 * @provides Azure.ContainerApps.StopJobExecution
 */
export const StopJobExecutionHttp = Layer.effect(
  StopJobExecution,
  makeJobActionBinding({
    tag: "Azure.ContainerApps.StopJobExecution",
    operation: app.StopJobExecution,
    grant: ContainerAppsRole.JobExecutionStop,
  }),
);
