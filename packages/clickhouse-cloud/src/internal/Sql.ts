import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { SqlError } from "effect/sql/SqlError";
import type { Service } from "../Service/Service.ts";

type ClickhouseModule = typeof import("@effect/sql-clickhouse/ClickhouseClient");
export type ClickhouseClient = Effect.Success<ReturnType<ClickhouseModule["make"]>>;

/**
 * Resolve, when a SQL binding's layer is built, how the host reaches a
 * service over the ClickHouse HTTP interface: its HTTPS URL and the
 * `default` user's password, both read back through `RuntimeContext`. The
 * returned function opens an `@effect/sql-clickhouse` client for one use and
 * closes it after. `@effect/sql-clickhouse` (an optional peer) is loaded on
 * first use, so hosts that don't bind SQL never import it.
 */
export const bindSql = Effect.fn(function* (target: Service) {
  const url = yield* target.httpsUrl;
  const username = yield* target.username;
  const password = yield* target.password;
  return <A, E, R>(use: (client: ClickhouseClient) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { make } = yield* Effect.promise(
        () => import("@effect/sql-clickhouse/ClickhouseClient"),
      );
      const secret = yield* password;
      const client = yield* make({
        url: yield* url,
        username: yield* username,
        password: secret === undefined ? undefined : Redacted.value(secret),
      });
      return yield* use(client);
    }).pipe(Effect.scoped, Effect.provide(Reactivity.layer)) as Effect.Effect<
      A,
      E | SqlError,
      Exclude<R, Scope.Scope> | RuntimeContext
    >;
});
