import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CollectorTelemetry, tracedRpc } from "../../../Utils/Telemetry.ts";

/** A private Cloud Run Service whose `traced` RPC method records a span per call. */
export default class TracedCallee extends GCP.Function<TracedCallee>()(
  "TracedCallee",
  { main: import.meta.url, location: "us-central1" },
  Effect.succeed({
    ...tracedRpc,
    fetch: Effect.succeed(HttpServerResponse.text("traced callee ok")),
  }).pipe(Effect.provide(CollectorTelemetry("gcp-rpc-callee"))),
) {}
