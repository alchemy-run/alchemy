import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../Utils/Telemetry.ts";

const TracedApp = Effect.gen(function* () {
  const environment = yield* Modal.Environment("TracedEnv", {});
  return yield* Modal.App("TracedApp", { environment });
});

/** A Server that exports one span per `/work` request over OTLP. */
export default class TracedServer extends Modal.Server<TracedServer>()(
  "TracedServer",
  { main: import.meta.url, app: TracedApp, unauthenticated: true },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("modal-server-e2e")),
  ),
) {}
