/**
 * Athena as an engine, over Alchemy's `AWS.Athena.Query` binding: the
 * binding carries the workgroup, the results bucket and the IAM grants; the
 * engine compiles each query with positional `?` parameters, passes them as
 * execution parameters (Trino SQL literals), and reads every page of the
 * result with its column types.
 *
 * @module
 */
import type { QueryResult, RunQueryRequest } from "@alchemy.run/aws/Athena";
import * as Arr from "effect/Array";
import * as BigInt_ from "effect/BigInt";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import { detailOf } from "../internal.ts";
import { EngineUnavailable, type Implementation, QueryFailed, QueryRefused } from "./Engine.ts";
import { literal, timestampOf } from "./Trino.ts";

const compiler = Statement.makeCompilerSqlite();

/** An Athena cell as JSON by its column type. Athena sends every cell as text. */
const valueOf = (type: string, cell: string | null): Schema.Json =>
  cell === null
    ? null
    : Match.value(type).pipe(
        Match.when("boolean", () => cell === "true"),
        Match.whenOr("tinyint", "smallint", "integer", "int", "bigint", () =>
          Option.match(Option.flatMap(BigInt_.fromString(cell), BigInt_.toNumber), {
            onNone: () => cell,
            onSome: (number) => number,
          }),
        ),
        Match.whenOr("real", "float", "double", () => Number(cell)),
        Match.when(
          (t: string) => t.startsWith("timestamp"),
          () => timestampOf(cell),
        ),
        Match.orElse(() => cell),
      );

/** A run of the binding: the function `AWS.Athena.Query(workGroup, results)` returns. */
export type RunQuery<E> = (request: RunQueryRequest) => Effect.Effect<QueryResult, E>;

/** What `Export.Athena.engine` runs on. */
export interface EngineOptions<E> {
  /** The bound query: `yield* AWS.Athena.Query(workGroup, resultsBucket)`. */
  readonly query: RunQuery<E>;
  /**
   * The name each table is read under, e.g. `Export.Iceberg.names(Lake)`
   * for a lake in the Glue catalog; by default its stable name.
   */
  readonly name?: Implementation["name"];
}

/**
 * Athena on a bound workgroup. The binding reads every page of a result
 * before it returns, so `stream` emits a result once the query has finished.
 *
 * ### Querying the lake with Athena
 * **Example:** The engine in a Lambda, on a bound workgroup
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as Athena from "@alchemy.run/domain/Export/Athena";
 * import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
 * import * as Effect from "effect/Effect";
 *
 * export const AnalyticsLive = Analytics.toLayer(
 *   Effect.gen(function* () {
 *     const query = yield* AWS.Athena.Query(workGroup, resultsBucket);
 *     const name = yield* Iceberg.names(Lake, { catalog: "awsdatacatalog" });
 *     return yield* Athena.engine({ query, name });
 *   }),
 * );
 * ```
 *
 * @layer
 * @title Athena
 * @provides Export.Engine.Implementation
 * @peer @alchemy.run/aws
 */
export const engine = <E>(options: EngineOptions<E>): Effect.Effect<Implementation> => {
  const run = (query: Statement.Fragment) => {
    const [text, parameters] = compiler.compile(query, false);
    return options
      .query({
        QueryString: text,
        ...(parameters.length === 0 ? {} : { ExecutionParameters: Arr.map(parameters, literal) }),
      })
      .pipe(
        // A query Athena ran and ended `FAILED` or `CANCELLED` (`AthenaQueryFailed`) is
        // refused; any other failure of the binding (a throttled or denied call) may pass.
        Effect.mapError(
          (cause) =>
            new QueryFailed({
              reason: Predicate.isTagged(cause, "AthenaQueryFailed")
                ? new QueryRefused({
                    code: Predicate.hasProperty(cause, "state") ? String(cause.state) : cause._tag,
                  })
                : new EngineUnavailable({
                    code: Predicate.hasProperty(cause, "_tag")
                      ? String(cause._tag)
                      : "AthenaUnavailable",
                  }),
              detail: detailOf(cause),
              cause,
            }),
        ),
        Effect.map((result) =>
          Arr.map(result.values, (row) =>
            Object.fromEntries(
              Arr.map(
                result.columns,
                (column, index) =>
                  [column, valueOf(result.types[index] ?? "varchar", row[index] ?? null)] as const,
              ),
            ),
          ),
        ),
      );
  };
  return Effect.succeed({
    dialect: "athena",
    name: options.name,
    run,
    stream: (query) => Stream.unwrap(Effect.map(run(query), Stream.fromIterable)),
  } satisfies Implementation);
};
