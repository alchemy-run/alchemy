import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  TelemetryFunction,
  TelemetryFunctionLive,
} from "./src/TelemetryFunction.ts";

export default Alchemy.Stack(
  "LambdaOpenTelemetry",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const fn = yield* TelemetryFunction.pipe(
      Effect.provide(
        TelemetryFunctionLive({
          main: import.meta.resolve("./src/TelemetryFunction.ts"),
          architecture: "arm64",
          memorySize: 512,
          timeout: Duration.seconds(15),
          url: true,
          // The extension layer, the configuration layer, and the extension's
          // environment are attached by `AWS.Lambda.Collector` inside the
          // Function's Effect — no telemetry plumbing appears in these props.
          // Deliberately not OTEL_EXPORTER_OTLP_ENDPOINT: the standard SDK
          // variable would also aim the in-process exporter at the remote
          // backend and bypass the extension.
          otlpEndpoint: yield* Config.string(
            "COLLECTOR_EXPORTER_OTLP_ENDPOINT",
          ),
        }),
      ),
    );

    return { url: fn.functionUrl };
  }),
);
