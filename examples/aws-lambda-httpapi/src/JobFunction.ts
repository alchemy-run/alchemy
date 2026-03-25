import { AWS } from "alchemy-effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { JobApi } from "./JobApi.ts";
import {
  JobNotifications,
  JobNotificationsSNS,
  NotifyJobError,
} from "./JobNotifications.ts";
import {
  GetJobError,
  JobStorage,
  JobStorageDynamoDB,
  PutJobError,
} from "./JobStorage.ts";

export class JobFunction extends AWS.Lambda.Function<JobFunction>()(
  "JobFunction",
  {
    main: import.meta.path,
    url: true,
  },
) {}

export const JobFunctionLive = JobFunction.make(
  Effect.gen(function* () {
    const jobService = yield* JobStorage;
    const notifications = yield* JobNotifications;

    return yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(JobApi).pipe(
        Layer.provide(
          HttpApiBuilder.group(JobApi, "Jobs", (handlers) =>
            handlers
              .handle(
                "getJob",
                Effect.fn(function* (req) {
                  if (!req.query.jobId) {
                    return HttpServerResponse.text("Job ID is required", {
                      status: 400,
                    });
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
                    return HttpServerResponse.text(job.message, {
                      status: 500,
                    });
                  }
                  if (!job) {
                    return HttpServerResponse.text("Job not found", {
                      status: 404,
                    });
                  }
                  return job!;
                }),
              )
              .handle(
                "createJob",
                Effect.fn(function* (req) {
                  const jobId = crypto.randomUUID();
                  const job = yield* jobService
                    .putJob({
                      id: jobId,
                      content: req.payload.content,
                    })
                    .pipe(
                      Effect.catchTag("PutJobError", (error) =>
                        Effect.succeed(error),
                      ),
                    );
                  if (job instanceof PutJobError) {
                    return HttpServerResponse.text(job.message, {
                      status: 500,
                    });
                  }
                  const notificationResult = yield* notifications
                    .notifyJobCreated(job)
                    .pipe(
                      Effect.catchTag("NotifyJobError", (error) =>
                        Effect.succeed(error),
                      ),
                    );
                  if (notificationResult instanceof NotifyJobError) {
                    return HttpServerResponse.text(notificationResult.message, {
                      status: 500,
                    });
                  }
                  return job.id;
                }),
              ),
          ),
        ),
        Layer.provide(HttpServer.layerServices),
      ),
    );
  }).pipe(
    Effect.provide(Layer.mergeAll(JobStorageDynamoDB, JobNotificationsSNS)),
  ),
);

export default JobFunctionLive;
