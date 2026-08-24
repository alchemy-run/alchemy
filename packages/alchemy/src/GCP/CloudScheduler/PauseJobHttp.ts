import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import * as Layer from "effect/Layer";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import { PauseJob } from "./PauseJob.ts";

/**
 * HTTP implementation of {@link PauseJob}.
 *
 * @layer
 * @provides GCP.CloudScheduler.PauseJob
 */
export const PauseJobHttp = Layer.effect(
  PauseJob,
  makeJobHttpBinding({
    tag: "GCP.CloudScheduler.PauseJob",
    operation: scheduler.pauseProjectsLocationsJobs,
  }),
);
