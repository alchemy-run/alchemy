import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Job, JobId } from "./Job.ts";

export const getJob = HttpApiEndpoint.get("getJob", "/", {
  success: Job,
  query: {
    jobId: JobId.pipe(Schema.optional),
  },
});

export const createJob = HttpApiEndpoint.post("createJob", "/", {
  success: JobId,
  payload: Schema.Struct({
    content: Schema.String,
  }),
});

export const JobApi = HttpApi.make("JobApi").add(
  HttpApiGroup.make("Jobs").add(getJob, createJob),
);
