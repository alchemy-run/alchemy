import {
  collector,
  Exporter,
  pipeline,
  Processor,
  Receiver,
} from "@/AWS/Lambda/CollectorConfig.ts";
import * as Duration from "effect/Duration";

/**
 * The Collector configuration the extension live-test deploys.
 *
 * Its own module so the fixture Function and the test that asserts on the
 * emitted file share one definition — the assertions are then about what is
 * actually deployed, not a copy of it.
 */

/**
 * Both placeholders are written by hand rather than handed to the typed
 * channel: the test drives them through `CollectorProps.env`, which is what
 * keeps the deployed layer identical across runs while the backend endpoint
 * and the injected delay vary per test.
 */
export const OTLP_ENDPOINT_VAR = "COLLECTOR_EXPORTER_OTLP_ENDPOINT";
export const EXPORT_DELAY_VAR = "OTEL_TEST_EXPORT_DELAY_MS";

const otlp = Receiver.otlp({
  protocols: { http: { endpoint: "127.0.0.1:4318" } },
});

const processors = [
  Processor.memoryLimiter({
    checkInterval: Duration.seconds(1),
    limitMib: 128,
    spikeLimitMib: 32,
  }),
  Processor.batch({ timeout: Duration.millis(100) }),
  Processor.decouple({ maxQueueSize: 200 }),
];

const otlphttp = Exporter.otlpHttp({
  endpoint: `\${env:${OTLP_ENDPOINT_VAR}}`,
  headers: { "x-otel-test-delay-ms": `\${env:${EXPORT_DELAY_VAR}}` },
});

export const otelExtensionCollectorConfig = collector({
  pipelines: {
    traces: pipeline({ receivers: [otlp], processors, exporters: [otlphttp] }),
    logs: pipeline({ receivers: [otlp], processors, exporters: [otlphttp] }),
  },
});
