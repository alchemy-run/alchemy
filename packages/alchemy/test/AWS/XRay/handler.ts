import * as Lambda from "@/AWS/Lambda";
import * as XRay from "@/AWS/XRay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class XRayTestFunction extends Lambda.Function<Lambda.Function>()(
  "XRayTestFunction",
) {}

export default XRayTestFunction.make(
  {
    main,
    url: true,
    // Active tracing: every sampled invocation of this function produces an
    // X-Ray trace whose service name is the function name.
    tracing: "Active",
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const getTraceSummaries = yield* XRay.GetTraceSummaries();
    const batchGetTraces = yield* XRay.BatchGetTraces();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ping") {
          const functionName = yield* Effect.sync(
            () => process.env.AWS_LAMBDA_FUNCTION_NAME,
          );
          return yield* HttpServerResponse.json({ ok: true, functionName });
        }

        if (request.method === "GET" && pathname === "/trace-summaries") {
          const service = url.searchParams.get("service");
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* getTraceSummaries({
            StartTime: new Date(now - 10 * 60 * 1000),
            EndTime: new Date(now),
            FilterExpression: service ? `service("${service}")` : undefined,
          }).pipe(
            // X-Ray read APIs have low TPS quotas; the test polls this route
            // while sibling suites run, so absorb throttling in the fixture.
            Effect.retry({
              while: (error) => error._tag === "ThrottledException",
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(5),
              ]),
            }),
          );
          return yield* HttpServerResponse.json({
            traceIds: (result.TraceSummaries ?? []).flatMap((summary) =>
              summary.Id ? [summary.Id] : [],
            ),
          });
        }

        if (request.method === "GET" && pathname === "/batch-get-traces") {
          const ids = url.searchParams.get("ids");
          const result = yield* batchGetTraces({
            TraceIds: ids ? ids.split(",") : [],
          }).pipe(
            Effect.retry({
              while: (error) => error._tag === "ThrottledException",
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(5),
              ]),
            }),
          );
          return yield* HttpServerResponse.json({
            traces: (result.Traces ?? []).map((trace) => ({
              id: trace.Id,
              segments: trace.Segments?.length ?? 0,
            })),
            unprocessed: result.UnprocessedTraceIds ?? [],
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
      Layer.mergeAll(XRay.GetTraceSummariesHttp, XRay.BatchGetTracesHttp),
    ),
  ),
);
