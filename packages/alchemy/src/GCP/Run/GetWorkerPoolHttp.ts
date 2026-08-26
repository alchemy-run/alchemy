import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetWorkerPool, type GetWorkerPoolRequest } from "./GetWorkerPool.ts";
import type { WorkerPool } from "./WorkerPool.ts";

/**
 * HTTP implementation of {@link GetWorkerPool}.
 *
 * @layer
 * @provides GCP.Run.GetWorkerPool
 */
export const GetWorkerPoolHttp = Layer.effect(
  GetWorkerPool,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <T extends WorkerPool>(pool: T) {
      const name = yield* pool.name;
      return Effect.fn(`GCP.Run.GetWorkerPool(${pool.LogicalId})`)(function* (
        request?: GetWorkerPoolRequest,
      ) {
        return yield* cloudrun
          .getProjectsLocationsWorkerPools({
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
