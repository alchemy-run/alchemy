import * as Telemetry from "alchemy/Telemetry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** OTLP export to the suite's collector; its url is bound at deploy. */
export const RpcTelemetry = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.String("OTLP_EVENT_FLUSH_URL");
    return Telemetry.layerOtlp({ traces: { url }, serviceName: "otel-rpc-test" });
  }),
);
