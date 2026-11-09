import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CollectorTelemetry, tracedCallerFetch } from "../../../Utils/Telemetry.ts";
import TracedCallee from "./traced-rpc-callee.ts";

/** A public Cloud Run Service that calls {@link TracedCallee} inside a span of its own. */
export default class TracedCaller extends GCP.Function<TracedCaller>()(
  "TracedCaller",
  { main: import.meta.url, location: "us-central1", invokerIamDisabled: true },
  Effect.gen(function* () {
    const callee = yield* GCP.Run.InvokeService(TracedCallee);
    return { fetch: tracedCallerFetch(callee) };
  }).pipe(
    Effect.provide(Layer.mergeAll(GCP.Run.InvokeServiceHttp, CollectorTelemetry("gcp-rpc-caller"))),
  ),
) {}
