import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { WorkstationCluster } from "./WorkstationCluster.ts";
import type { WorkstationClustersWorkstationConfig } from "./WorkstationClustersWorkstationConfig.ts";
import type { WorkstationClustersWorkstationConfigsWorkstation } from "./WorkstationClustersWorkstationConfigsWorkstation.ts";

/**
 * Shared HTTP scaffolding for Cloud Workstations bindings.
 * NOT exported from index.ts.
 */
export const makeClusterHttpBinding = <
  I extends { name?: string },
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
    return Effect.fn(function* (cluster: WorkstationCluster) {
      const name = yield* cluster.name;
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* options
          .operation({
            ...(request as I),
            name: yield* name,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });

export const makeConfigHttpBinding = <
  I extends { name?: string },
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
    return Effect.fn(function* (config: WorkstationClustersWorkstationConfig) {
      const name = yield* config.name;
      return Effect.fn(`${options.tag}(${config.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* options
          .operation({
            ...(request as I),
            name: yield* name,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });

export const makeWorkstationHttpBinding = <
  I extends { name?: string },
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
    return Effect.fn(function* (
      workstation: WorkstationClustersWorkstationConfigsWorkstation,
    ) {
      const name = yield* workstation.name;
      return Effect.fn(`${options.tag}(${workstation.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* options
          .operation({
            ...(request as I),
            name: yield* name,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });

export const makeGenerateAccessTokenHttpBinding = <
  I extends { workstation?: string },
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
    return Effect.fn(function* (
      workstation: WorkstationClustersWorkstationConfigsWorkstation,
    ) {
      const name = yield* workstation.name;
      return Effect.fn(`${options.tag}(${workstation.LogicalId})`)(function* (
        request?: Omit<I, "workstation">,
      ) {
        return yield* options
          .operation({
            ...(request as I),
            workstation: yield* name,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });
