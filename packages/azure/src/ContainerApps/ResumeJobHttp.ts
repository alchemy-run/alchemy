import * as app from "@distilled.cloud/azure/app";
import * as Layer from "effect/Layer";
import { makeJobActionBinding, ContainerAppsRole } from "./BindingHttp.ts";
import { ResumeJob } from "./ResumeJob.ts";

/**
 * Implementation of {@link ResumeJob} over the distilled `app` ARM
 * operation `ResumeJob`. Assigns the custom `AzureContainerAppsJobResumeRole` on the
 * job.
 *
 * @layer
 * @provides Azure.ContainerApps.ResumeJob
 */
export const ResumeJobHttp = Layer.effect(
  ResumeJob,
  makeJobActionBinding({
    tag: "Azure.ContainerApps.ResumeJob",
    operation: app.ResumeJob,
    grant: ContainerAppsRole.JobResume,
  }),
);
