import * as Lambda from "@/AWS/Lambda";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Lambda fixture for Telemetry.test.ts: exercises the default env-driven
 * OTLP path. The `Config` reads during Init bind the deploy-time values
 * (provided by the test's ConfigProvider override) onto the Function's env,
 * where the runtime telemetry layer re-reads them per invocation.
 *
 * `GET /work` runs a child span and a log so the test can assert traces AND
 * logs arrive at the collector after the invocation scope flushes.
 */
export class OtelTestFunction extends Lambda.Function<Lambda.Function>()(
  "OtelTelemetryFunction",
) {}

export const OtelTestFunctionLive = OtelTestFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    // Read during Init so the deploy-time Config interceptor binds the
    // resolved values onto the Lambda's env vars of the same names.
    yield* Config.string("OTEL_EXPORTER_OTLP_ENDPOINT");
    yield* Config.string("OTEL_SERVICE_NAME");

    const doWork = Effect.fn("lambda.child-span")(function* () {
      yield* Effect.log("lambda-work-log");
      return "lambda-did-work";
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/work") {
          const marker = yield* doWork();
          return yield* HttpServerResponse.json({ marker });
        }
        // Readiness gate for the test: the collector's workers.dev URL
        // propagates per-PoP, so it can serve placeholder 404s to the
        // Lambda's region long after the test machine sees it. The test
        // polls this route until it reports 200 before asserting on
        // exported telemetry.
        if (url.pathname === "/probe") {
          const endpoint = yield* Config.string(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
          ).pipe(Effect.orDie);
          const result = yield* Effect.tryPromise(() =>
            fetch(`${endpoint}/v1/probe`, {
              method: "POST",
              body: JSON.stringify({ probe: true }),
            }).then(async (r) => ({
              status: r.status,
              body: (await r.text()).slice(0, 200),
            })),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({ status: -1, body: String(cause) }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }
        return HttpServerResponse.text("otel-lambda-ok");
      }),
    };
  }),
);

export default OtelTestFunctionLive;
