import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Schema from "effect/Schema";
import { Job, JobId, JobNotFound, JobStoreUnavailable } from "./Job.ts";

const JobParams = Schema.Struct({ id: JobId });

export const createJob = HttpApiEndpoint.post("createJob", "/jobs", {
  payload: Schema.Struct({ content: Schema.String }),
  success: Job.pipe(HttpApiSchema.status(201)),
  error: JobStoreUnavailable,
});

export const getJob = HttpApiEndpoint.get("getJob", "/jobs/:id", {
  params: JobParams,
  success: Job,
  error: [JobNotFound, JobStoreUnavailable],
});

export const listJobs = HttpApiEndpoint.get("listJobs", "/jobs", {
  success: Schema.Array(Job),
  error: JobStoreUnavailable,
});

export const deleteJob = HttpApiEndpoint.delete("deleteJob", "/jobs/:id", {
  params: JobParams,
  success: HttpApiSchema.NoContent,
  error: JobStoreUnavailable,
});

export const health = HttpApiEndpoint.get("health", "/health", {
  success: Schema.String,
});

/**
 * The API contract. The Function serves it, and the test (or any client)
 * derives a typed client from the same value with `HttpApiClient.make`.
 */
export class JobApi extends HttpApi.make("JobApi").add(
  HttpApiGroup.make("Jobs").add(createJob, getJob, listJobs, deleteJob, health),
) {}
