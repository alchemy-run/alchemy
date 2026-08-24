import * as container from "@distilled.cloud/gcp/container_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetNodePool, type GetNodePoolRequest } from "./GetNodePool.ts";
import type { NodePool } from "./NodePool.ts";

/**
 * HTTP implementation of {@link GetNodePool}.
 *
 * @layer
 * @provides GCP.Container.GetNodePool
 */
export const GetNodePoolHttp = Layer.effect(
  GetNodePool,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <T extends NodePool>(nodePool: T) {
      const name = yield* nodePool.name;
      return Effect.fn(`GCP.Container.GetNodePool(${nodePool.LogicalId})`)(
        function* (request?: GetNodePoolRequest) {
          return yield* container
            .getProjectsLocationsClustersNodePools({
              ...request,
              name: yield* name,
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
