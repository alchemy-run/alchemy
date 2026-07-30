import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import type { InputProps } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const sandboxId = crypto.randomUUID();

export class TelemetryFunction extends AWS.Lambda.Function<TelemetryFunction>()(
  "TelemetryFunction",
) {}

const implementation = Effect.gen(function* () {
  const work = Effect.fn("telemetry.example.work")(function* (marker: string) {
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
    Alchemy.Telemetry.layerOtlp({
      // Scope finalization waits only for the local Collector receiver.
      // The external extension owns the remote export lifecycle.
      url: "http://127.0.0.1:4318",
      serviceName: "alchemy-lambda-opentelemetry-example",
    }),
  ),
);

export const TelemetryFunctionLive = (
  props: InputProps<AWS.Lambda.FunctionProps>,
) => TelemetryFunction.make(props, implementation);

export default TelemetryFunction.make(
  { main: import.meta.url },
  implementation,
);
