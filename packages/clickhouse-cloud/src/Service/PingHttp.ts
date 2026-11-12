import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlCallFailed } from "../Errors.ts";
import { bindSql } from "../internal/Sql.ts";
import { Ping } from "./Ping.ts";
import type { Service } from "./Service.ts";

/** {@link Ping} over the ClickHouse HTTP interface; Node.js hosts and Workers. */
export const PingHttp = Layer.succeed(
  Ping,
  Effect.fn(function* (target: Service) {
    const withClient = yield* bindSql(target);
    return () =>
      withClient((client) =>
        Effect.tryPromise({
          try: () => client.client.ping(),
          catch: (cause) => new SqlCallFailed({ operation: "ping", cause }),
        }).pipe(Effect.map((result) => result.success)),
      );
  }),
);
