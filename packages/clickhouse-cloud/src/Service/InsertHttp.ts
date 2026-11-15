import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindSql } from "../internal/Sql.ts";
import { Insert, type InsertRequest } from "./Insert.ts";
import type { Service } from "./Service.ts";

/** {@link Insert} over the ClickHouse HTTP interface; Node.js hosts. */
export const InsertHttp = Layer.succeed(
  Insert,
  Effect.fn(function* (target: Service) {
    const withClient = yield* bindSql(target);
    return (request: InsertRequest) =>
      withClient((client) =>
        client
          .insertQuery({
            table: request.table,
            values: [...request.values],
            format: "JSONEachRow",
            ...(request.columns !== undefined
              ? { columns: request.columns as [string, ...string[]] }
              : {}),
          })
          .pipe(Effect.asVoid),
      );
  }),
);
