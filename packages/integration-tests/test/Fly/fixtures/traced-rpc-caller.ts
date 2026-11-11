import * as Fly from "@alchemy.run/fly";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedCallerFetch } from "../../Utils/Telemetry.ts";
import TracedCallee from "./traced-rpc-callee.ts";

/** A public Service that calls {@link TracedCallee} over RPC inside a span of its own. */
export default class TracedCaller extends Fly.Service<TracedCaller>()(
  "TracedCaller",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      region: "iad",
      network: yield* Fly.stackNetwork,
      guest: { cpuKind: "shared" as const, cpus: 1, memoryMb: 256 },
    };
  }),
  Effect.gen(function* () {
    const callee = yield* Fly.bindService(TracedCallee);
    return { fetch: tracedCallerFetch(callee) };
  }).pipe(Effect.provide(CollectorTelemetry("fly-rpc-caller"))),
) {}
