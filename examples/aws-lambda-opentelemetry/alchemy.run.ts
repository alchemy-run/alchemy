import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import { collectorExtensionLayerArn } from "./src/Collector.ts";
import {
  TelemetryFunction,
  TelemetryFunctionLive,
} from "./src/TelemetryFunction.ts";

const architecture = "arm64" as const;
const collectorConfigPath = fileURLToPath(
  new URL("./layers/collector-config", import.meta.url),
);

export default Alchemy.Stack(
  "LambdaOpenTelemetry",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { region } = yield* AWS.AWSEnvironment.current;
    const remoteOtlpEndpoint = yield* Config.string(
      "COLLECTOR_EXPORTER_OTLP_ENDPOINT",
    );

    // This layer contains configuration only. The managed layer below
    // contains and starts the external Collector extension.
    const collectorConfig = yield* AWS.Lambda.LayerVersion("CollectorConfig", {
      path: collectorConfigPath,
      compatibleArchitectures: [architecture],
      description: "OpenTelemetry Collector configuration",
    });

    const fn = yield* TelemetryFunction.pipe(
      Effect.provide(
        TelemetryFunctionLive({
          main: import.meta.resolve("./src/TelemetryFunction.ts"),
          architecture,
          memorySize: 512,
          timeout: Duration.seconds(15),
          url: true,
          layers: [
            collectorExtensionLayerArn({ region, architecture }),
            collectorConfig,
          ],
          env: {
            OPENTELEMETRY_COLLECTOR_CONFIG_URI: "/opt/collector.yaml",
            // This is intentionally not OTEL_EXPORTER_OTLP_ENDPOINT. Using the
            // standard SDK variable here would also point the in-process
            // Effect exporter at the remote backend and bypass the extension.
            COLLECTOR_EXPORTER_OTLP_ENDPOINT: remoteOtlpEndpoint,
          },
        }),
      ),
    );

    return { url: fn.functionUrl };
  }),
);
