import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlCallFailed } from "../Errors.ts";
import { bindSql } from "../internal/Sql.ts";
import { Query } from "./Query.ts";
import type { Service } from "./Service.ts";

/** {@link Query} over the ClickHouse HTTP interface; Node.js hosts. */
export const QueryHttp = Layer.succeed(
  Query,
  Effect.fn(function* (target: Service) {
    const withClient = yield* bindSql(target);
    return (sql: string, params?: Record<string, unknown>) =>
      withClient((client) =>
        Effect.tryPromise({
          try: async () => {
            const result = await client.client.query({
              query: sql,
              query_params: params,
              format: "JSONEachRow",
            });
            return (await result.json()) as Array<Record<string, unknown>>;
          },
          catch: (cause) => new SqlCallFailed({ operation: "query", cause }),
        }),
      );
  }),
);
