import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker exercising the *default* telemetry path: no code
 * changes, only the standard `OTEL_*` environment variables. The collector
 * URL is resolved at deploy time from the deployer's environment
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, provided by Telemetry.test.ts after the
 * collector deploys).
 *
 * `GET /work` runs a child span and a log so the test can assert traces
 * AND logs arrive at the collector after the request scope flushes.
 */
export default class OtelTracedWorker extends Cloudflare.Worker<OtelTracedWorker>()(
  "OtelTracedWorker",
  {
    main: import.meta.url,
    env: {
      // Config key must equal the env key: the Worker's props re-execute
      // inside the deployed isolate, where the same Config is re-read from
      // the bound env var of the same name.
      OTEL_EXPORTER_OTLP_ENDPOINT: Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"),
      OTEL_SERVICE_NAME: "otel-traced-test",
    },
  },
  Effect.gen(function* () {
    const doWork = Effect.fn("test.child-span")(function* () {
      yield* Effect.log("did-work-log");
      return "did-work";
    });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/work") {
          const result = yield* doWork();
          return yield* HttpServerResponse.json({ marker: result });
        }
        // Readiness gate for the test: OTLP export goes worker->worker, so
        // the collector's custom domain must be reachable *from inside a
        // Worker* (workers.dev would be blocked with error 1042). The test
        // polls this route until it reports 200 before asserting on
        // exported telemetry.
        if (url.pathname === "/probe") {
          const endpoint = yield* Config.string(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
          ).pipe(Effect.orDie);
          const result = yield* Effect.tryPromise(() =>
            fetch(`${endpoint}/v1/traces`, {
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
        return HttpServerResponse.text("otel-traced-ok");
      }),
    };
  }),
) {}
