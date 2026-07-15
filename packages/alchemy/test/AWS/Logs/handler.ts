import * as Lambda from "@/AWS/Lambda";
import * as Logs from "@/AWS/Logs";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class LogsTestFunction extends Lambda.Function<Lambda.Function>()(
  "LogsTestFunction",
) {}

class QueryNotComplete extends Data.TaggedError("QueryNotComplete")<{
  readonly status: string | undefined;
}> {}

export default LogsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const logGroup = yield* Logs.LogGroup("BindingsLogGroup", {
      retention: "1 day",
    });
    const logStream = yield* Logs.LogStream("BindingsLogStream", {
      logGroupName: logGroup.logGroupName,
      logStreamName: "alchemy-test-bindings-stream",
    });

    const putLogEvents = yield* Logs.PutLogEvents(logGroup);
    const filterLogEvents = yield* Logs.FilterLogEvents(logGroup);
    const getLogEvents = yield* Logs.GetLogEvents(logGroup);
    const startQuery = yield* Logs.StartQuery(logGroup);
    const getQueryResults = yield* Logs.GetQueryResults(logGroup);

    const LogStreamName = yield* logStream.logStreamName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const logStreamName = yield* LogStreamName;

        if (request.method === "POST" && pathname === "/put") {
          const message = url.searchParams.get("message") ?? "no-message";
          const timestamp = yield* Clock.currentTimeMillis;
          const result = yield* putLogEvents({
            logStreamName,
            logEvents: [{ timestamp, message }],
          });
          return yield* HttpServerResponse.json({
            ok: true,
            rejected: result.rejectedLogEventsInfo ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/filter") {
          const pattern = url.searchParams.get("pattern") ?? "";
          const result = yield* filterLogEvents({
            filterPattern: `"${pattern}"`,
          });
          return yield* HttpServerResponse.json({
            messages: (result.events ?? []).map((event) => event.message),
          });
        }

        if (request.method === "GET" && pathname === "/get-events") {
          const result = yield* getLogEvents({
            logStreamName,
            startFromHead: true,
          });
          return yield* HttpServerResponse.json({
            messages: (result.events ?? []).map((event) => event.message),
          });
        }

        if (request.method === "GET" && pathname === "/query") {
          const now = yield* Clock.currentTimeMillis;
          const { queryId } = yield* startQuery({
            queryString: "fields @timestamp, @message | limit 10",
            startTime: Math.floor(now / 1000) - 3600,
            endTime: Math.floor(now / 1000) + 60,
          });
          if (!queryId) {
            return yield* HttpServerResponse.json(
              { error: "no queryId" },
              { status: 500 },
            );
          }
          // Poll bounded (~20s) — well inside the 30s function timeout.
          const results = yield* getQueryResults({ queryId }).pipe(
            Effect.flatMap((response) =>
              response.status === "Complete"
                ? Effect.succeed(response)
                : Effect.fail(
                    new QueryNotComplete({ status: response.status }),
                  ),
            ),
            Effect.retry({
              while: (error) => error._tag === "QueryNotComplete",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          return yield* HttpServerResponse.json({
            queryId,
            status: results.status,
            resultCount: (results.results ?? []).length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logs.PutLogEventsHttp,
        Logs.FilterLogEventsHttp,
        Logs.GetLogEventsHttp,
        Logs.StartQueryHttp,
        Logs.GetQueryResultsHttp,
      ),
    ),
  ),
);
