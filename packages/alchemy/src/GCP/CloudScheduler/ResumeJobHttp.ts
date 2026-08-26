import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import { ResumeJob } from "./ResumeJob.ts";

/**
 * HTTP implementation of {@link ResumeJob}.
 *
 * @layer
 * @provides GCP.CloudScheduler.ResumeJob
 */
export const ResumeJobHttp: Layer.Layer<
  ResumeJob,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  ResumeJob,
  makeJobHttpBinding<
    scheduler.ResumeProjectsLocationsJobsRequest,
    scheduler.Job,
    scheduler.ResumeProjectsLocationsJobsError
  >({
    tag: "GCP.CloudScheduler.ResumeJob",
    operation: scheduler.resumeProjectsLocationsJobs,
  }),
);
