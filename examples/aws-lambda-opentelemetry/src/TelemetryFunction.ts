import * as AWS from "alchemy/AWS";
import type { InputProps } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { fileURLToPath } from "node:url";

const sandboxId = crypto.randomUUID();

const collectorConfigPath = fileURLToPath(
  new URL("../layers/collector-config", import.meta.url),
);

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
      // `layers/collector-config/collector.yaml` into a LayerVersion, and
      // aims this Function's telemetry at the extension's loopback receiver.
      // The extension owns the remote export, so backend latency never sits
      // in front of the response.
      AWS.Lambda.Collector({
        config: collectorConfigPath,
        serviceName: "alchemy-lambda-opentelemetry-example",
        env: { COLLECTOR_EXPORTER_OTLP_ENDPOINT: otlpEndpoint },
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
