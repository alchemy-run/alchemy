import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { RunJob, type RunJobRequest } from "./RunJob.ts";
import type { Job } from "./Job.ts";

/**
 * HTTP implementation of {@link RunJob}.
 *
 * @layer
 * @provides GCP.Run.RunJob
 */
export const RunJobHttp = Layer.effect(
  RunJob,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <T extends Job>(job: T) {
      const name = yield* job.name;
      return Effect.fn(`GCP.Run.RunJob(${job.LogicalId})`)(function* (
        request?: RunJobRequest,
      ) {
        return yield* cloudrun
          .runProjectsLocationsJobs({
            ...request,
            name: yield* name,
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
