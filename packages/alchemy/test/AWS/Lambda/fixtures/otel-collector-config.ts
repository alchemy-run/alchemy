import {
  collector,
  Exporter,
  pipeline,
  Processor,
  Receiver,
} from "@/AWS/Lambda/CollectorConfig.ts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";

/**
 * The Collector configuration the extension live-test deploys.
 *
 * Its own module so the fixture Function and the test that asserts on the
 * emitted file share one definition — the assertions are then about what is
 * actually deployed, not a copy of it.
 */

/**
 * Both values are REFERENCED rather than carried: the config names two
 * variables the deployed Function provides, and the handler supplies them
 * through `CollectorProps.env`. That split is what keeps the deployed layer
 * byte-identical across runs while the backend endpoint and the injected delay
 * vary per test — a deploy-time `Output` would rebuild the layer every run.
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
  endpoint: Config.string(OTLP_ENDPOINT_VAR),
  headers: { "x-otel-test-delay-ms": Config.string(EXPORT_DELAY_VAR) },
});

export const otelExtensionCollectorConfig = collector({
  pipelines: {
    traces: pipeline({ receivers: [otlp], processors, exporters: [otlphttp] }),
    logs: pipeline({ receivers: [otlp], processors, exporters: [otlphttp] }),
  },
});
