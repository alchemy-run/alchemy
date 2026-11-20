import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CollectorTelemetry, tracedRpc } from "../../Utils/Telemetry.ts";
import { Partition, Site } from "./suite-env.ts";

/** A Service whose `traced` RPC method records a span per call. */
export default class TracedCallee extends Railway.Service<TracedCallee>()(
  "TracedCallee",
  { project: Site, environment: Partition, main: import.meta.url, port: 3000 },
  Effect.succeed({
    ...tracedRpc,
    fetch: Effect.succeed(HttpServerResponse.text("traced callee ok")),
  }).pipe(Effect.provide(CollectorTelemetry("railway-rpc-callee"))),
) {}
