import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Database } from "./Database.ts";
import { GetDdl, type GetDdlRequest } from "./GetDdl.ts";

/**
 * HTTP implementation of {@link GetDdl}.
 *
 * @layer
 * @provides GCP.Spanner.GetDdl
 */
export const GetDdlHttp = Layer.effect(
  GetDdl,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (database: Database) {
      const name = yield* database.name;
      return Effect.fn(`GCP.Spanner.GetDdl(${database.LogicalId})`)(function* (
        request?: GetDdlRequest,
      ) {
        return yield* spanner
          .getDdlProjectsInstancesDatabases({
            ...request,
            database: yield* name,
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
