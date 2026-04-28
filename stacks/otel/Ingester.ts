import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Logs, Metrics, Traces } from "./Datasets.ts";
import { IngestToken } from "./IngestToken.ts";

/**
 * Public OTLP/HTTP relay for the alchemy CLI.
 *
 * Receives OTLP/JSON payloads on `/v1/{traces,logs,metrics}` and proxies
 * them to the configured Axiom datasets, attaching the ingest token
 * server-side so we never have to ship it to end users.
 *
 * Environment (set by `stacks/otel.ts`):
 * - `AXIOM_TRACES_ENDPOINT`  — full Axiom OTLP traces URL
 * - `AXIOM_LOGS_ENDPOINT`    — full Axiom OTLP logs URL
 * - `AXIOM_METRICS_ENDPOINT` — full Axiom OTLP metrics URL
 * - `AXIOM_INGEST_TOKEN`     — Bearer token (Redacted)
 */
export default class Ingester extends Cloudflare.Worker<Ingester>()(
  "OtelWorker",
  Stack.useSync(({ stage }) => ({
    main: import.meta.path,
    observability: { enabled: true },
    domain: stage === "prod" ? "otel.alchemy.run" : undefined,
    compatibility: {
      date: "2026-03-17",
      flags: ["nodejs_compat"],
    },
  })),
  Effect.gen(function* () {
    const tokenValue = yield* (yield* IngestToken).token;
    const traces = yield* Traces;
    const logs = yield* Logs;
    const metrics = yield* Metrics;
    const tracesEndpoint = yield* traces.otelTracesEndpoint;
    const logsEndpoint = yield* logs.otelLogsEndpoint;
    const metricsEndpoint = yield* metrics.otelMetricsEndpoint;
    const tracesDataset = yield* traces.name;
    const logsDataset = yield* logs.name;
    const metricsDataset = yield* metrics.name;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.method !== "POST") {
          return HttpServerResponse.text("Method not allowed", { status: 405 });
        }

        const path = new URL(request.url, "http://x").pathname;
        const route =
          path === "/v1/traces"
            ? { endpoint: yield* tracesEndpoint, dataset: yield* tracesDataset }
            : path === "/v1/logs"
              ? { endpoint: yield* logsEndpoint, dataset: yield* logsDataset }
              : path === "/v1/metrics"
                ? {
                    endpoint: yield* metricsEndpoint,
                    dataset: yield* metricsDataset,
                  }
                : undefined;

        if (!route) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }

        const { endpoint: target, dataset } = route;

        const tokenRaw = yield* tokenValue.pipe(Effect.map(Redacted.value));
        const token = Redacted.isRedacted(tokenRaw)
          ? Redacted.value(tokenRaw)
          : (tokenRaw as string);

        const body = yield* request.text;

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(target, {
              method: "POST",
              headers: {
                "content-type":
                  request.headers["content-type"] ?? "application/json",
                authorization: `Bearer ${token}`,
                "x-axiom-dataset": dataset,
              },
              body,
            }),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        });

        const responseBody = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        });

        return HttpServerResponse.text(responseBody, {
          status: response.status,
          headers: {
            "content-type":
              response.headers.get("content-type") ?? "application/json",
          },
        });
      }).pipe(
        Effect.catch((err) =>
          Effect.succeed(
            HttpServerResponse.text(`Relay error: ${err.message}`, {
              status: 502,
            }),
          ),
        ),
      ),
    };
  }),
) {}
