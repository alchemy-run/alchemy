import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as youtubereporting from "@distilled.cloud/gcp/youtubereporting_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetJob, type GetJobRequest } from "./GetJob.ts";
import type { Job } from "./Job.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link GetJob}.
 *
 * @layer
 * @provides GCP.Youtubereporting.GetJob
 */
export const GetJobHttp = Layer.effect(
  GetJob,
  Effect.gen(function* () {
    const getJobs = yield* youtubereporting.getJobs;
    return Effect.fn(function* (job: Job) {
      yield* bindGcpHost({
        tag: "GCP.Youtubereporting.GetJob",
        resource: job,
        iam: [{ role: defaultRoleFor("GCP.Youtubereporting.GetJob") }],
      });
      const jobId = yield* job.jobId;
      const onBehalfOfContentOwner = yield* job.onBehalfOfContentOwner;
      return Effect.fn(`GCP.Youtubereporting.GetJob(${job.LogicalId})`)(
        function* (request: GetJobRequest) {
          return yield* getJobs({
            jobId: yield* jobId,
            onBehalfOfContentOwner:
              request.onBehalfOfContentOwner ?? (yield* onBehalfOfContentOwner),
          });
        },
      );
    });
  }),
);
