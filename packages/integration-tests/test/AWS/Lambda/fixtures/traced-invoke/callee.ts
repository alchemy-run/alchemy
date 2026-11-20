import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import { CollectorTelemetry } from "../../../../Utils/Telemetry.ts";

export class TracedInvokeCallee extends Lambda.Function<Lambda.Function>()("TracedInvokeCallee") {}

/** An Effect function that claims `{ traced: tag }` invocations and records `rpc-callee:<tag>`. */
export default TracedInvokeCallee.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    yield* host.listen(
      Effect.sync(() => (event: { readonly traced?: unknown }) => {
        if (typeof event?.traced !== "string") return undefined;
        return Effect.succeed({ traced: event.traced }).pipe(
          Effect.withSpan(`rpc-callee:${event.traced}`),
        );
      }),
    );
    return {};
  }).pipe(Effect.provide(CollectorTelemetry("lambda-invoke-callee"))),
);
