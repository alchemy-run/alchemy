import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Database } from "./Database.ts";
import { ExecuteSql, type ExecuteSqlRequest } from "./ExecuteSql.ts";

/**
 * HTTP implementation of {@link ExecuteSql}.
 *
 * @layer
 * @provides GCP.Spanner.ExecuteSql
 */
export const ExecuteSqlHttp = Layer.effect(
  ExecuteSql,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const withClient = <A, E, R>(
      effect: Effect.Effect<A, E, R | Credentials | HttpClient.HttpClient>,
    ) =>
      effect.pipe(
        Effect.provideService(Credentials, credentials),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    const dropSession = (session: string | undefined) => {
      if (session === undefined || session.length === 0) return Effect.void;
      return withClient(
        spanner
          .deleteProjectsInstancesDatabasesSessions({ name: session })
          .pipe(Effect.catchTag("NotFound", () => Effect.void)),
      ).pipe(Effect.ignore);
    };
    return Effect.fn(function* (database: Database) {
      const name = yield* database.name;
      return Effect.fn(`GCP.Spanner.ExecuteSql(${database.LogicalId})`)(
        function* (request: ExecuteSqlRequest) {
          const databaseName = yield* name;
          const session = yield* withClient(
            spanner.createProjectsInstancesDatabasesSessions({
              database: databaseName,
              body: { session: {} },
            }),
          );
          return yield* withClient(
            spanner.executeSqlProjectsInstancesDatabasesSessions({
              session: session.name ?? "",
              body: request,
            }),
          ).pipe(Effect.ensuring(dropSession(session.name)));
        },
      );
    });
  }),
);
