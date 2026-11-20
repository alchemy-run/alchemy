import * as Fly from "@alchemy.run/fly";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CollectorTelemetry, tracedRpc } from "../../Utils/Telemetry.ts";

/** A private Service whose `traced` method records a span per call. */
export default class TracedCallee extends Fly.Service<TracedCallee>()(
  "TracedCallee",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      region: "iad",
      public: false,
      network: yield* Fly.stackNetwork,
      guest: { cpuKind: "shared" as const, cpus: 1, memoryMb: 256 },
    };
  }),
  Effect.succeed({
    ...tracedRpc,
    // Fly's default check needs a listener on the Service's port.
    fetch: Effect.succeed(HttpServerResponse.text("traced callee ok")),
  }).pipe(Effect.provide(CollectorTelemetry("fly-rpc-callee"))),
) {}
