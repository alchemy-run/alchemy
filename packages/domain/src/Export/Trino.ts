/**
 * Trino as an engine, over its client REST protocol: a query is posted to
 * `/v1/statement` and its pages followed through `nextUri`. The protocol has
 * no parameter binding, so a query with parameters runs as
 * `EXECUTE IMMEDIATE '…' USING …` with each parameter as a SQL literal.
 * Athena's engine is Trino, so `literal` and `timestampOf` serve it too.
 *
 * @module
 */
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import { detailOf, toJson } from "../internal.ts";
import { EngineUnavailable, type Implementation, QueryFailed, QueryRefused } from "./Engine.ts";

const compiler = Statement.makeCompilerSqlite();

const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** A `DateTime` as a Trino timestamp literal's text: `2026-01-01 10:00:00.000 UTC`. */
const timestampText = (date: Date) =>
  DateTime.formatIso(DateTime.fromDateUnsafe(date)).replace("T", " ").replace("Z", " UTC");

/** A bound parameter as a Trino SQL literal. */
export const literal: (value: unknown) => string = Match.type<unknown>().pipe(
  Match.when(Predicate.isNullish, () => "NULL"),
  Match.when(Predicate.isBoolean, (boolean) => (boolean ? "TRUE" : "FALSE")),
  Match.when(Predicate.isNumber, (number) =>
    Number.isNaN(number)
      ? "nan()"
      : Number.isFinite(number)
        ? String(number)
        : number > 0
          ? "infinity()"
          : "-infinity()",
  ),
  Match.when(Predicate.isBigInt, String),
  Match.when(Predicate.isDate, (date) => `TIMESTAMP ${quoted(timestampText(date))}`),
  Match.when(Predicate.isString, quoted),
  Match.orElse((value) => quoted(String(value))),
);

/**
 * A Trino-family timestamp as an ISO string: `2026-01-01 10:00:00.000 UTC`
 * (or zoneless, which the session's UTC time zone makes UTC) becomes
 * `2026-01-01T10:00:00.000Z`. Text it cannot read stays as it is, so the
 * query's Schema reports it.
 */
export const timestampOf = (text: string): string => {
  const iso = `${text.replace(" ", "T").replace(/ UTC$/, "")}Z`;
  return Option.match(DateTime.make(iso), { onNone: () => text, onSome: DateTime.formatIso });
};

const Column = Schema.Struct({ name: Schema.String, type: Schema.String });
/** Trino's error: `errorType` says whose fault it is (`USER_ERROR`, or the cluster's own). */
const TrinoError = Schema.Struct({
  message: Schema.String,
  errorName: Schema.String,
  errorType: Schema.optionalKey(Schema.String),
});

/** One page of a Trino response (`QueryResults`), the fields an engine reads. */
const QueryResults = Schema.Struct({
  nextUri: Schema.optionalKey(Schema.String),
  columns: Column.pipe(Schema.Array, Schema.optionalKey),
  data: Schema.Unknown.pipe(Schema.Array, Schema.Array, Schema.optionalKey),
  error: Schema.optionalKey(TrinoError),
});
type QueryResults = typeof QueryResults.Type;

/** The query as Trino text: its parameters inlined through `EXECUTE IMMEDIATE`, when it has any. */
const textOf = (query: Statement.Fragment): string => {
  const [text, parameters] = compiler.compile(query, false);
  return parameters.length === 0
    ? text
    : `EXECUTE IMMEDIATE ${quoted(text)} USING ${Arr.map(parameters, literal).join(", ")}`;
};

/** A row as JSON by its columns' types: timestamps as ISO strings, the rest as Trino sends them. */
const rowOf = (
  columns: ReadonlyArray<typeof Column.Type>,
  row: ReadonlyArray<unknown>,
): Schema.JsonObject =>
  Object.fromEntries(
    Arr.map(columns, (column, index) => {
      const value = row[index];
      return [
        column.name,
        column.type.startsWith("timestamp") && Predicate.isString(value)
          ? timestampOf(value)
          : toJson(value),
      ] as const;
    }),
  );

/** Where `Export.Trino.engine` reaches Trino, and as whom. */
export interface EngineOptions {
  /** The coordinator's base URL, e.g. `http://trino:8080`. */
  readonly url: string;
  /** The session's user (`X-Trino-User`). */
  readonly user: string;
  /** The session's catalog, for names that do not give one. */
  readonly catalog?: string | undefined;
  /** The session's schema, for names that do not give one. */
  readonly schema?: string | undefined;
  /** The `Authorization` header, for a cluster behind authentication (e.g. `Bearer …`). */
  readonly authorization?: Redacted.Redacted<string> | undefined;
  /**
   * The name each table is read under, e.g. `Export.Iceberg.names(Lake, { catalog: "lake" })`;
   * by default its stable name, resolved in the session's catalog and schema.
   */
  readonly name?: Implementation["name"];
}

/**
 * Trino over its client protocol on the `HttpClient` in context. The session
 * runs in UTC. A 429, 502, 503 or 504 is retried, as the protocol asks. A
 * query Trino rejects as the user's error (`USER_ERROR`) is `QueryRefused`;
 * a failure of the cluster or the connection is `EngineUnavailable`.
 *
 * ### Querying a lake through Trino
 * **Example:** Trino's Iceberg catalog, reached in the cluster
 * ```typescript
 * import * as Export from "@alchemy.run/domain/Export";
 * import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
 * import * as Effect from "effect/Effect";
 * import * as FetchHttpClient from "effect/http/FetchHttpClient";
 * import * as Layer from "effect/Layer";
 *
 * export const AnalyticsLive = Analytics.toLayer(
 *   Effect.flatMap(Iceberg.names(Lake, { catalog: "lake" }), (name) =>
 *     Export.Trino.engine({ url: "http://trino:8080", user: "domain", catalog: "lake", name }),
 *   ),
 * ).pipe(Layer.provide(LakeLive), Layer.provide(FetchHttpClient.layer));
 * ```
 *
 * ### Querying Postgres through Trino
 * **Example:** Trino's PostgreSQL connector over a SQL store
 * ```typescript
 * export const AnalyticsLive = Analytics.toLayer(
 *   Export.Trino.engine({ url, user: "domain", catalog: "postgresql", schema: "public" }),
 * ).pipe(Layer.provide(FetchHttpClient.layer));
 * ```
 *
 * @layer
 * @title Trino
 * @provides Export.Engine.Implementation
 */
export const engine = (
  options: EngineOptions,
): Effect.Effect<Implementation, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({ times: 5 }),
    );
    const headers = {
      "X-Trino-User": options.user,
      "X-Trino-Source": "alchemy-domain-export",
      "X-Trino-Time-Zone": "UTC",
      ...(options.catalog === undefined ? {} : { "X-Trino-Catalog": options.catalog }),
      ...(options.schema === undefined ? {} : { "X-Trino-Schema": options.schema }),
      ...(options.authorization === undefined
        ? {}
        : { Authorization: Redacted.value(options.authorization) }),
    };
    const page = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(QueryResults)),
        Effect.mapError(
          (cause) =>
            new QueryFailed({
              reason: new EngineUnavailable({ code: "TrinoHttp" }),
              detail: detailOf(cause),
              cause,
            }),
        ),
        Effect.flatMap(({ error, ...results }) =>
          error === undefined
            ? Effect.succeed(results)
            : Effect.fail(
                new QueryFailed({
                  reason:
                    error.errorType === "USER_ERROR"
                      ? new QueryRefused({ code: error.errorName })
                      : new EngineUnavailable({ code: error.errorName }),
                  detail: error.message,
                }),
              ),
        ),
      );
    /** A query's rows page by page: the columns arrive with the first page that has them, the rows after. */
    const stream = (query: Statement.Fragment) =>
      Stream.paginate(
        HttpClientRequest.post(`${options.url}/v1/statement`).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyText(textOf(query)),
        ),
        (request) =>
          Effect.map(
            page(request),
            (
              results,
            ): readonly [
              ReadonlyArray<QueryResults>,
              Option.Option<HttpClientRequest.HttpClientRequest>,
            ] => [
              [results],
              Option.map(Option.fromNullishOr(results.nextUri), (next) =>
                HttpClientRequest.get(next),
              ),
            ],
          ),
      ).pipe(
        Stream.mapAccum(
          (): ReadonlyArray<typeof Column.Type> => [],
          (columns, results) => {
            const known = results.columns ?? columns;
            return [known, Arr.map(results.data ?? [], (row) => rowOf(known, row))] as const;
          },
        ),
      );
    return {
      dialect: "trino",
      name: options.name,
      run: (query) => Stream.runCollect(stream(query)),
      stream,
    } satisfies Implementation;
  });
