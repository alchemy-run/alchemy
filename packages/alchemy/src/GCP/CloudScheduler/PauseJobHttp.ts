import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import { PauseJob } from "./PauseJob.ts";

/**
 * HTTP implementation of {@link PauseJob}.
 *
 * @layer
 * @provides GCP.CloudScheduler.PauseJob
 */
export const PauseJobHttp: Layer.Layer<
  PauseJob,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  PauseJob,
  makeJobHttpBinding<
    scheduler.PauseProjectsLocationsJobsRequest,
    scheduler.Job,
    scheduler.PauseProjectsLocationsJobsError
  >({
    tag: "GCP.CloudScheduler.PauseJob",
    operation: scheduler.pauseProjectsLocationsJobs,
  }),
);
