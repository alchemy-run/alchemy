import * as Lambda from "@/AWS/Lambda";
import type { InputProps } from "@/Input.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const sandboxId = crypto.randomUUID();

export class AxiomPlatformExtensionFunction extends Lambda.Function<Lambda.Function>()(
  "AxiomPlatformExtensionFunction",
) {}

const implementation = Effect.gen(function* () {
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://x");
      const marker =
        url.searchParams.get("marker") ??
        `alchemy-axiom-platform-${crypto.randomUUID()}`;
      yield* Effect.logInfo("alchemy Axiom Lambda extension test").pipe(
        Effect.annotateLogs({
          event_name: "alchemy.axiom_lambda_extension.test",
          "telemetry.marker": marker,
        }),
      );
      return yield* HttpServerResponse.json({ marker, sandboxId });
    }),
  };
});

export const AxiomPlatformExtensionFunctionLive = (
  props: InputProps<Lambda.FunctionProps>,
) => AxiomPlatformExtensionFunction.make(props, implementation);

export default AxiomPlatformExtensionFunction.make(
  { main: import.meta.url },
  implementation,
);
