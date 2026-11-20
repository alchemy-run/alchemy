import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedRpc } from "../../Utils/Telemetry.ts";
import { TracedRpcApp } from "./traced-rpc-app.ts";

/** A Function whose `traced` RPC method records a span per call (reached through Modal's relay). */
export default class TracedRpcFunction extends Modal.Function<TracedRpcFunction>()(
  "TracedRpcFunction",
  { main: import.meta.url, app: TracedRpcApp },
  Effect.succeed({ ...tracedRpc }).pipe(Effect.provide(CollectorTelemetry("modal-rpc-function"))),
) {}
