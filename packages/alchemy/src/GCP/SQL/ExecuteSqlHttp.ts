import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ExecuteSql, type ExecuteSqlRequest } from "./ExecuteSql.ts";
import type { Instance } from "./Instance.ts";

/**
 * HTTP implementation of {@link ExecuteSql}.
 *
 * @layer
 * @provides GCP.SQL.ExecuteSql
 */
export const ExecuteSqlHttp = Layer.effect(
  ExecuteSql,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (instance: Instance) {
      const instanceName = yield* instance.instanceName;
      const project = yield* instance.project;
      return Effect.fn(`GCP.SQL.ExecuteSql(${instance.LogicalId})`)(function* (
        request: ExecuteSqlRequest,
      ) {
        return yield* sqladmin
          .executeSqlInstances({
            ...request,
            instance: yield* instanceName,
            project: yield* project,
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
