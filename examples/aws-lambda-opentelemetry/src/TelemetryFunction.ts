import * as AWS from "alchemy/AWS";
import type { InputProps } from "alchemy/Input";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const sandboxId = crypto.randomUUID();

/**
 * The Collector's configuration, written in TypeScript rather than as a
 * `collector.yaml` on disk. Every component is validated against the
 * collector's own config schema at the call that declares it, the config
 * sections are derived from what the pipelines reference, and
 * `AWS.Lambda.Collector` packages the result into a layer.
 *
 * `memory_limiter` runs first so a backpressured backend sheds load instead
 * of pushing the sandbox into an OOM kill; `decouple` runs last, which is
 * what moves remote export off the response path. One receiver, one
 * processor set and one exporter VALUE are shared by both pipelines, so each
 * is declared exactly once in the emitted file.
 */
const collectorConfig = (otlpEndpoint: string) => {
  const otlp = AWS.Lambda.Receiver.otlp({
    protocols: { http: { endpoint: "127.0.0.1:4318" } },
  });
  const processors = [
    AWS.Lambda.Processor.memoryLimiter({
      checkInterval: Duration.seconds(1),
      limitMib: 128,
      spikeLimitMib: 32,
    }),
    AWS.Lambda.Processor.batch({ timeout: Duration.seconds(1) }),
    AWS.Lambda.Processor.decouple({
      // Once full, this in-memory queue applies backpressure to the
      // function's local export. It improves latency; it does not make
      // delivery durable.
      maxQueueSize: 200,
    }),
  ];
  const otlphttp = AWS.Lambda.Exporter.otlpHttp({ endpoint: otlpEndpoint });

  return AWS.Lambda.collector({
    pipelines: {
      traces: AWS.Lambda.pipeline({
        receivers: [otlp],
        processors,
        exporters: [otlphttp],
      }),
      logs: AWS.Lambda.pipeline({
        receivers: [otlp],
        processors,
        exporters: [otlphttp],
      }),
    },
  });
};

export class TelemetryFunction extends AWS.Lambda.Function<TelemetryFunction>()(
  "TelemetryFunction",
) {}

/**
 * `otlpEndpoint` is only read at deploy time, when the Collector's
 * environment is bound. The bundled runtime entry below re-executes this
 * same Effect inside the Lambda, where binding is a no-op and only the
 * loopback exporter matters — hence the default.
 */
const implementation = (otlpEndpoint = "") =>
  Effect.gen(function* () {
    const work = Effect.fn("telemetry.example.work")(function* (
      marker: string,
    ) {
      yield* Effect.annotateCurrentSpan("telemetry.marker", marker);
      yield* Effect.log("telemetry example invocation").pipe(
        Effect.annotateLogs("telemetry.marker", marker),
      );
      return marker;
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url);
        const marker = yield* work(
          url.searchParams.get("marker") ?? crypto.randomUUID(),
        );
        return yield* HttpServerResponse.json({
          marker,
          sandboxId,
        });
      }),
    };
  }).pipe(
    Effect.provide(
      // One call: attaches the pinned Collector extension layer, packages
      // the configuration above into a LayerVersion, and aims this
      // Function's telemetry at the extension's loopback receiver. The
      // extension owns the remote export, so backend latency never sits in
      // front of the response.
      AWS.Lambda.Collector({
        config: collectorConfig(otlpEndpoint),
        serviceName: "alchemy-lambda-opentelemetry-example",
      }),
    ),
  );

export const TelemetryFunctionLive = ({
  otlpEndpoint,
  ...props
}: InputProps<AWS.Lambda.FunctionProps> & { otlpEndpoint: string }) =>
  TelemetryFunction.make(props, implementation(otlpEndpoint));

export default TelemetryFunction.make(
  { main: import.meta.url },
  implementation(),
);
