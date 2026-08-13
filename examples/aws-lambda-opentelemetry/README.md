# Effect OpenTelemetry on AWS Lambda

This example sends Effect traces and logs to an OpenTelemetry
Collector running as an external Lambda extension:

```text
Effect handler
  -> invocation-scoped OTLP/HTTP export to 127.0.0.1:4318
  -> Collector external extension
  -> remote OTLP backend
```

All of that wiring is one call inside the Function's Effect:

```ts
Effect.provide(
  AWS.Lambda.Collector({
    config: AWS.Lambda.collector({
      pipelines: {
        traces: AWS.Lambda.pipeline({
          receivers: [
            AWS.Lambda.Receiver.otlp({
              protocols: { http: { endpoint: "127.0.0.1:4318" } },
            }),
          ],
          processors: [
            AWS.Lambda.Processor.memoryLimiter({
              checkInterval: Duration.seconds(1),
              limitMib: 128,
            }),
            AWS.Lambda.Processor.batch({ timeout: Duration.seconds(1) }),
            AWS.Lambda.Processor.decouple({ maxQueueSize: 200 }),
          ],
          exporters: [AWS.Lambda.Exporter.otlpHttp({ endpoint: otlpEndpoint })],
        }),
      },
    }),
  }),
)
```

The Collector is configured in TypeScript, not YAML. The component types
are generated from the collector's own Go config structs, so a misspelt
field fails at the constructor call that wrote it, with a JSON path — and
the component set is exactly the one the pinned extension ships. Sections
are never written by hand: a pipeline holds component *values*, so
`receivers:`, `processors:` and `exporters:` are derived from what the
pipelines use, and one value shared by two pipelines is one entry.

`AWS.Lambda.Collector` derives and attaches the pinned managed extension
layer (Region- and architecture-scoped: Lambda's `x86_64` maps to the
upstream layer's `amd64` name), serializes the configuration into a
`LayerVersion` at `/opt/collector.yaml`, binds the extension's environment,
and points the in-process exporter at the loopback receiver. Override the
pinning with `extension: { release, layerVersion }`, or bypass derivation
entirely with `extension: { layerVersionArn }`.

A string leaf is written as the value it is, never as a placeholder string.
An `Output` or a `Redacted` leaf binds to a generated environment variable
rather than being baked into the layer, so a rotated token or a repointed
backend never republishes it. A `Config` primitive —
`Config.string("BACKEND_URL")` — names a variable the deployed Function
already provides and renders as that name, binding nothing. Use
``AWS.Lambda.interpolate`Bearer ${token.value}` `` when a literal prefix and
a reference share one leaf.

Exporting to Axiom needs no configuration at all — `Axiom.LambdaCollector`
builds the configuration and wires the ingest token and datasets:

```ts
Effect.provide(Axiom.LambdaCollector({ token: Ingest, traces: Traces, logs: Logs }))
```

Set `COLLECTOR_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP backend and deploy:

```sh
COLLECTOR_EXPORTER_OTLP_ENDPOINT=https://otel.example.com \
  bun alchemy deploy --profile testing
```

The handler's invocation Scope flushes Effect telemetry to the local receiver
before returning. The `decouple` processor lets the extension perform the
remote export outside caller-visible response latency. `memory_limiter` bounds
Collector pressure before batching. Extension processing still consumes billed
time and shares the function's CPU, memory, environment, IAM role, and timeout.

This example is for vendor-neutral OTLP when Effect already provides the
instrumentation. For AWS-native X-Ray and Application Signals, use AWS's
optimized ADOT Lambda layers instead; they export without a dedicated
Collector. Adding a Node auto-instrumentation wrapper to this Function by
default can duplicate Effect's spans.

This is best-effort telemetry, not durable delivery. A timeout, out-of-memory
failure, reset, full in-memory queue, extension failure, or `SIGKILL` can lose
data. Write business-critical events to durable storage from the handler.

The remote endpoint and vendor headers belong in the Collector configuration,
while the application exporter knows only localhost. This is not secret
isolation: the external extension shares the Function's environment variables,
IAM role, CPU, and memory.

## Tests

Alchemy's AWS provider test deploys the same pattern with the real managed
extension, a bounded OTLP receiver, and a four-second receiver delay:

```sh
cd ../../packages/alchemy
timeout 240 bun run test \
  test/AWS/Lambda/OtelCollectorExtension.test.ts \
  --profile testing --concurrency 1 --retry 0
```

It asserts trace and log delivery, warm sandbox reuse, and that the delayed
remote receiver does not delay the handler response. The receiver, Function,
config layer, and S3 sink are destroyed on success or failure. ARN derivation
and the packaged Axiom configuration are covered by
`test/AWS/Lambda/Collector.test.ts`, which needs no cloud access.

References:

- [OpenTelemetry Lambda Collector](https://opentelemetry.io/docs/platforms/faas/lambda-collector/)
- [Collector layer release 0.22.0](https://github.com/open-telemetry/opentelemetry-lambda/releases/tag/layer-collector%2F0.22.0)
- [AWS Lambda extensions lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-extensions-api.html)
