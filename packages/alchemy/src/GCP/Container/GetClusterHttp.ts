import * as container from "@distilled.cloud/gcp/container_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetCluster, type GetClusterRequest } from "./GetCluster.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * HTTP implementation of {@link GetCluster}.
 *
 * @layer
 * @provides GCP.Container.GetCluster
 */
export const GetClusterHttp = Layer.effect(
  GetCluster,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <T extends Cluster>(cluster: T) {
      const name = yield* cluster.name;
      return Effect.fn(`GCP.Container.GetCluster(${cluster.LogicalId})`)(
        function* (request?: GetClusterRequest) {
          return yield* container
            .getProjectsLocationsClusters({
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
