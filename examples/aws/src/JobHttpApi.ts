import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Job, JobId } from "./Job.ts";
import { JobStorage } from "./JobStorage.ts";

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

const JobApiHandlers = HttpApiBuilder.group(JobApi, "Jobs", (handlers) =>
  handlers
    .handle(
      "getJob",
      Effect.fn(function* (req) {
        const jobService = yield* JobStorage;
        if (!req.query.jobId) {
          return HttpServerResponse.text("Job ID is required", { status: 400 });
        }
        const job = yield* jobService.getJob(req.query.jobId);
        if (!job) {
          return HttpServerResponse.text("Job not found", { status: 404 });
        }
        return job!;
      }),
    )
    .handle(
      "createJob",
      Effect.fn(function* (req) {
        const jobService = yield* JobStorage;
        const job = yield* jobService.putJob({
          id: "TODO",
          content: req.payload.content,
        });
        return job.id;
      }),
    ),
);

// Provide the implementation for the API
export const JobApiLive = HttpApiBuilder.layer(JobApi).pipe(
  Layer.provide(JobApiHandlers),
  // Layer.provide(HttpApiScalar.layer(JobApi)),
  Layer.provide(HttpServer.layerServices),
);

export const JobHttpEffect = HttpRouter.toHttpEffect(JobApiLive);
