import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as youtubereporting from "@distilled.cloud/gcp/youtubereporting_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetJob, type GetJobRequest } from "./GetJob.ts";
import type { Job } from "./Job.ts";

/**
 * HTTP implementation of {@link GetJob}.
 *
 * @layer
 * @provides GCP.Youtubereporting.GetJob
 */
export const GetJobHttp = Layer.effect(
  GetJob,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (job: Job) {
      const jobId = yield* job.jobId;
      const onBehalfOfContentOwner = yield* job.onBehalfOfContentOwner;
      return Effect.fn(`GCP.Youtubereporting.GetJob(${job.LogicalId})`)(
        function* (request: GetJobRequest) {
          return yield* youtubereporting
            .getJobs({
              jobId: yield* jobId,
              onBehalfOfContentOwner:
                request.onBehalfOfContentOwner ??
                (yield* onBehalfOfContentOwner),
            })
            .pipe(
              Effect.provideService(Credentials, credentials),
              Effect.provideService(HttpClient.HttpClient, httpClient),
            );
        },
      );
    });
  }),
);
