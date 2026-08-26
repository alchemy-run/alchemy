import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Database } from "./Database.ts";
import { ExecuteSql, type ExecuteSqlRequest } from "./ExecuteSql.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link ExecuteSql}.
 *
 * @layer
 * @provides GCP.Spanner.ExecuteSql
 */
export const ExecuteSqlHttp = Layer.effect(
  ExecuteSql,
  Effect.gen(function* () {
    const createSession =
      yield* spanner.createProjectsInstancesDatabasesSessions;
    const executeSql =
      yield* spanner.executeSqlProjectsInstancesDatabasesSessions;
    const deleteSession =
      yield* spanner.deleteProjectsInstancesDatabasesSessions;
    const dropSession = (session: string | undefined) => {
      if (session === undefined || session.length === 0) return Effect.void;
      return deleteSession({ name: session }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.ignore,
      );
    };
    return Effect.fn(function* (database: Database) {
      yield* bindGcpHost({
        tag: "GCP.Spanner.ExecuteSql",
        resource: database,
        iam: [{ role: defaultRoleFor("GCP.Spanner.ExecuteSql") }],
      });
      const name = yield* database.name;
      return Effect.fn(`GCP.Spanner.ExecuteSql(${database.LogicalId})`)(
        function* (request: ExecuteSqlRequest) {
          const databaseName = yield* name;
          const session = yield* createSession({
            database: databaseName,
            body: { session: {} },
          });
          return yield* executeSql({
            session: session.name ?? "",
            body: request,
          }).pipe(Effect.ensuring(dropSession(session.name)));
        },
      );
    });
  }),
);
