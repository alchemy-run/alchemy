import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Cluster } from "./Cluster.ts";

/**
 * Shared HTTP scaffolding for Dataproc cluster bindings.
 * NOT exported from index.ts.
 */
export const makeDataprocClusterHttpBinding = <
  I extends { projectId?: string; region?: string; clusterName?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: (
    input: I,
  ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (cluster: Cluster) {
      const clusterName = yield* cluster.clusterName;
      const region = yield* cluster.region;
      const project = yield* cluster.project;
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "projectId" | "region" | "clusterName">,
      ) {
        return yield* options
          .operation({
            ...(request as I),
            clusterName: yield* clusterName,
            region: yield* region,
            projectId: yield* project,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });
