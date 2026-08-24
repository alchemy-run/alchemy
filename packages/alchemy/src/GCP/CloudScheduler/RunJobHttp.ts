import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import * as Layer from "effect/Layer";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import { RunJob } from "./RunJob.ts";

/**
 * HTTP implementation of {@link RunJob}.
 *
 * @layer
 * @provides GCP.CloudScheduler.RunJob
 */
export const RunJobHttp = Layer.effect(
  RunJob,
  makeJobHttpBinding({
    tag: "GCP.CloudScheduler.RunJob",
    operation: scheduler.runProjectsLocationsJobs,
  }),
);
