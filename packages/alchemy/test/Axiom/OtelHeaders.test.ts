import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import type { ApiToken } from "@/Axiom/ApiToken";
import type { Dataset } from "@/Axiom/Dataset";
import { signal } from "@/Axiom/Telemetry";

// Offline: `signal` only reads the dataset's endpoint attributes and name, so
// plain objects stand in for the resource instances.
const token = { token: "ingest-token" } as unknown as ApiToken;
const dataset = (name: string) =>
  ({
    name,
    otelTracesEndpoint: "https://api.axiom.co/v1/traces",
    otelLogsEndpoint: "https://api.axiom.co/v1/logs",
    otelMetricsEndpoint: "https://api.axiom.co/v1/metrics",
  }) as unknown as Dataset;

const dataHeaders = (headers: Record<string, unknown> | undefined) =>
  Object.keys(headers ?? {}).filter((k) => k.toLowerCase().startsWith("x-axiom"));

describe("Axiom OTLP dataset header", { tags: ["unit", "local"] }, () => {
  it.effect("routes metrics with X-Axiom-Metrics-Dataset", () =>
    Effect.sync(() => {
      const options = signal(token, dataset("app-metrics"), "otelMetricsEndpoint");
      expect(dataHeaders(options?.headers)).toEqual(["X-Axiom-Metrics-Dataset"]);
      expect(options?.headers?.["X-Axiom-Metrics-Dataset"]).toBe("app-metrics");
    }),
  );

  it.effect("routes traces and logs with X-Axiom-Dataset", () =>
    Effect.sync(() => {
      for (const attr of ["otelTracesEndpoint", "otelLogsEndpoint"] as const) {
        const options = signal(token, dataset("app-data"), attr);
        expect(dataHeaders(options?.headers)).toEqual(["X-Axiom-Dataset"]);
        expect(options?.headers?.["X-Axiom-Dataset"]).toBe("app-data");
      }
    }),
  );
});
