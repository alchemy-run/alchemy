import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import * as Layer from "effect/Layer";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import { ResumeJob } from "./ResumeJob.ts";

/**
 * HTTP implementation of {@link ResumeJob}.
 *
 * @layer
 * @provides GCP.CloudScheduler.ResumeJob
 */
export const ResumeJobHttp = Layer.effect(
  ResumeJob,
  makeJobHttpBinding({
    tag: "GCP.CloudScheduler.ResumeJob",
    operation: scheduler.resumeProjectsLocationsJobs,
  }),
);
