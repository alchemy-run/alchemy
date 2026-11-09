import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CollectorTelemetry, tracedRpc } from "../../Utils/Telemetry.ts";
import { TracedRpcApp } from "./traced-rpc-app.ts";

/** A Server whose `traced` RPC method records a span per call (reached over HTTP). */
export default class TracedRpcServer extends Modal.Server<TracedRpcServer>()(
  "TracedRpcServer",
  { main: import.meta.url, app: TracedRpcApp },
  Effect.succeed({
    ...tracedRpc,
    fetch: Effect.succeed(HttpServerResponse.text("traced rpc server ok")),
  }).pipe(Effect.provide(CollectorTelemetry("modal-rpc-server"))),
) {}
