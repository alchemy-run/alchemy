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
import { JobNotifications, NotifyJobError } from "./JobNotifications.ts";
import { GetJobError, JobStorage, PutJobError } from "./JobStorage.ts";

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
        const job = yield* jobService.getJob(req.query.jobId).pipe(
          Effect.catchTag("GetJobError", (error) =>
            Effect.succeed(
              HttpServerResponse.text(error.message, {
                status: 500,
              }),
            ),
          ),
        );
        if (job instanceof GetJobError) {
          return HttpServerResponse.text(job.message, { status: 500 });
        }
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
        const notifications = yield* JobNotifications;
        const jobId = crypto.randomUUID();
        const job = yield* jobService
          .putJob({
            id: jobId,
            content: req.payload.content,
          })
          .pipe(
            Effect.catchTag("PutJobError", (error) => Effect.succeed(error)),
          );
        if (job instanceof PutJobError) {
          return HttpServerResponse.text(job.message, { status: 500 });
        }
        const notificationResult = yield* notifications
          .notifyJobCreated(job)
          .pipe(
            Effect.catchTag("NotifyJobError", (error) => Effect.succeed(error)),
          );
        if (notificationResult instanceof NotifyJobError) {
          return HttpServerResponse.text(notificationResult.message, {
            status: 500,
          });
        }
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
