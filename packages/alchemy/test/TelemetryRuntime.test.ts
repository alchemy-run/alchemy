import { packEnvValue } from "@/RuntimeContext.ts";
import {
  EXPORTERS_KEY,
  fromBoundConfig,
  type ResolvedDestination,
} from "@/TelemetryRuntime.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const serviceName = "telemetry-serialization-test";
const metricName = "telemetry.serialization.requests";
const spanName = "telemetry.serialization.span";
const logMessage = "telemetry serialization log";

// The inner scope closes before returning, so assertions observe the final
// export for each signal without waiting for periodic exporter timers.
const exportSignals = (config: Record<string, string>) =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request);
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );
    yield* Effect.gen(function* () {
      yield* Metric.update(Metric.counter(metricName), 1);
      yield* Effect.logInfo(logMessage);
      yield* Effect.void.pipe(Effect.withSpan(spanName));
    }).pipe(
      Effect.provide(fromBoundConfig),
      Effect.scoped,
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          OTEL_SERVICE_NAME: serviceName,
          ...config,
        }),
      ),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    );
    return requests;
  });

const bodyBytes = (request: HttpClientRequest.HttpClientRequest) => {
  expect(request.method).toBe("POST");
  expect(request.body._tag).toBe("Uint8Array");
  if (request.body._tag !== "Uint8Array") {
    throw new Error(`Unexpected OTLP body: ${request.body._tag}`);
  }
  expect(request.body.body.byteLength).toBeGreaterThan(0);
  return request.body.body;
};

const expectMetrics = (request: HttpClientRequest.HttpClientRequest) => {
  expect(request.headers["content-type"]).toBe("application/x-protobuf");
  const bytes = bodyBytes(request);
  // Protobuf strings are embedded as UTF-8. Check that this event's counter
  // and resource actually reached the batch, rather than just an empty body.
  const text = new TextDecoder().decode(bytes);
  expect(text).toContain(metricName);
  expect(text).toContain(serviceName);
  expect(() => JSON.parse(text)).toThrow();
};

const expectJsonSignal = (
  request: HttpClientRequest.HttpClientRequest,
  signal: "traces" | "logs",
) => {
  expect(request.headers["content-type"]).toBe("application/json");
  const payload = JSON.parse(new TextDecoder().decode(bodyBytes(request)));
  expect(payload).toHaveProperty(
    signal === "traces" ? "resourceSpans" : "resourceLogs",
  );
  expect(JSON.stringify(payload)).toContain(serviceName);
  expect(JSON.stringify(payload)).toContain(
    signal === "traces" ? spanName : logMessage,
  );
};

describe("runtime OTLP serialization", { tags: ["unit", "local"] }, () => {
  it.effect(
    "exports protobuf metrics and JSON traces and logs from a standard endpoint",
    () =>
      Effect.gen(function* () {
        const endpoint = "https://collector.example";
        const requests = yield* exportSignals({
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        });
        expect(requests).toHaveLength(3);
        for (const signal of ["metrics", "traces", "logs"] as const) {
          const matches = requests.filter(
            (request) => request.url === `${endpoint}/v1/${signal}`,
          );
          expect(matches).toHaveLength(1);
          for (const request of matches) {
            signal === "metrics"
              ? expectMetrics(request)
              : expectJsonSignal(request, signal);
          }
        }
      }),
  );

  it.effect(
    "exports only metrics when only the metrics endpoint is configured",
    () =>
      Effect.gen(function* () {
        const endpoint = "https://collector.example/custom-metrics";
        const requests = yield* exportSignals({
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
          OTEL_EXPORTER_OTLP_METRICS_HEADERS:
            "authorization=Bearer%20metrics-token",
        });
        expect(requests).toHaveLength(1);
        for (const request of requests) {
          expect(request.url).toBe(endpoint);
          expect(request.headers.authorization).toBe("Bearer metrics-token");
          expectMetrics(request);
        }
      }),
  );

  it.effect(
    "preserves signal bodies and destination headers through bound and standard fanout",
    () =>
      Effect.gen(function* () {
        const endpoints = ["https://first.example", "https://second.example"];
        const destinations: ResolvedDestination[] = endpoints.map(
          (endpoint, index) => {
            const target = (signal: string) => ({
              url: `${endpoint}/v1/${signal}`,
              headers: {
                authorization: `Bearer bound-${index}`,
                "x-axiom-dataset": `${signal}-${index}`,
              },
            });
            return {
              metrics: target("metrics"),
              traces: target("traces"),
              logs: target("logs"),
            };
          },
        );
        const standard = "https://standard.example";
        const requests = yield* exportSignals({
          [EXPORTERS_KEY]: packEnvValue(destinations),
          OTEL_EXPORTER_OTLP_ENDPOINT: standard,
          OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20standard-token",
        });
        expect(requests).toHaveLength(9);
        for (const signal of ["metrics", "traces", "logs"] as const) {
          const batches = requests.filter((request) =>
            request.url.endsWith(`/v1/${signal}`),
          );
          expect(batches).toHaveLength(3);
          const bodies = batches.map(bodyBytes);
          expect(bodies[1]).toEqual(bodies[0]);
          expect(bodies[2]).toEqual(bodies[0]);
          for (const [index, endpoint] of [...endpoints, standard].entries()) {
            const matches = batches.filter(
              (request) => request.url === `${endpoint}/v1/${signal}`,
            );
            expect(matches).toHaveLength(1);
            for (const request of matches) {
              expect(request.headers.authorization).toBe(
                index < 2 ? `Bearer bound-${index}` : "Bearer standard-token",
              );
              expect(request.headers["x-axiom-dataset"]).toBe(
                index < 2 ? `${signal}-${index}` : undefined,
              );
              signal === "metrics"
                ? expectMetrics(request)
                : expectJsonSignal(request, signal);
            }
          }
        }
      }),
  );

  it.effect("does not export when no destinations are configured", () =>
    Effect.gen(function* () {
      expect(yield* exportSignals({})).toEqual([]);
    }),
  );
});
