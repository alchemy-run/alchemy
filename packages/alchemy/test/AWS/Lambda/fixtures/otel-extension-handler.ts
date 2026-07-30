import * as Lambda from "@/AWS/Lambda";
import type { InputProps } from "@/Input.ts";
import * as Telemetry from "@/Telemetry.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const sandboxId = crypto.randomUUID();

export class OtelExtensionFunction extends Lambda.Function<Lambda.Function>()(
  "OtelExtensionFunction",
) {}

const implementation = Effect.gen(function* () {
  const work = Effect.fn("lambda.extension.child-span")(function* (
    marker: string,
  ) {
    yield* Effect.annotateCurrentSpan("telemetry.marker", marker);
    yield* Effect.log("lambda-extension-work-log").pipe(
      Effect.annotateLogs("telemetry.marker", marker),
    );
    return marker;
  });

  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://x");
      const marker = yield* work(
        url.searchParams.get("marker") ?? crypto.randomUUID(),
      );
      return yield* HttpServerResponse.json({ marker, sandboxId });
    }),
  };
}).pipe(
  Effect.provide(
    Telemetry.layerOtlp({
      url: "http://127.0.0.1:4318",
      serviceName: "otel-lambda-extension-test",
    }),
  ),
);

export const OtelExtensionFunctionLive = (
  props: InputProps<Lambda.FunctionProps>,
) => OtelExtensionFunction.make(props, implementation);

export default OtelExtensionFunction.make(
  { main: import.meta.url },
  implementation,
);
