# Effect OpenTelemetry on AWS Lambda

This example sends Effect traces and logs to an OpenTelemetry
Collector running as an external Lambda extension:

```text
Effect handler
  -> invocation-scoped OTLP/HTTP export to 127.0.0.1:4318
  -> Collector external extension
  -> remote OTLP backend
```

The Collector extension is delivered by the pinned upstream managed Lambda
layer. A separate Alchemy `LayerVersion` packages `collector.yaml` at
`/opt/collector.yaml`.

The managed layer ARN is derived from the active AWS Region and the Function
architecture. Lambda's `x86_64` maps to the upstream layer's `amd64` name;
`arm64` remains `arm64`. Keep the release and layer version pinned in
`src/Collector.ts`.

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

The example's unit test checks Region and architecture mapping:

```sh
bun test
```

Alchemy's AWS provider test deploys the same pattern with the real managed
extension, a bounded OTLP receiver, and a four-second receiver delay:

```sh
cd ../../packages/alchemy
timeout 240 bun alchemy-test \
  test/AWS/Lambda/OtelCollectorExtension.test.ts \
  --profile testing --concurrency 1 --retry 0
```

It asserts trace and log delivery, warm sandbox reuse, and that the delayed
remote receiver does not delay the handler response. The receiver, Function,
config layer, and S3 sink are destroyed on success or failure.

References:

- [OpenTelemetry Lambda Collector](https://opentelemetry.io/docs/platforms/faas/lambda-collector/)
- [Collector layer release 0.22.0](https://github.com/open-telemetry/opentelemetry-lambda/releases/tag/layer-collector%2F0.22.0)
- [AWS Lambda extensions lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-extensions-api.html)
