import * as Archil from "@alchemy.run/archil";
import * as Telemetry from "alchemy/Telemetry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/**
 * An Effect program that exports its spans over OTLP. The collector url
 * resolves from the deployer's `COLLECTOR_URL` config at deploy time and
 * binds onto the sandbox; the bootstrap starts the exporters once per process.
 */
export default class TracedApi extends Archil.Sandbox<TracedApi>()(
  "TracedApi",
  { main: import.meta.url, port: 3002, idleTtlSeconds: 300 },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://program");
        const tag = url.searchParams.get("tag") ?? "none";
        if (url.pathname === "/work") {
          yield* Effect.log(`archil-work-log:${tag}`).pipe(Effect.withSpan(`archil-work:${tag}`));
          return HttpServerResponse.text(`did work ${tag}`);
        }
        return HttpServerResponse.text("traced ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const url = yield* Config.String("COLLECTOR_URL");
          return Telemetry.layerOtlp({ url, serviceName: "archil-sandbox-e2e" });
        }),
      ),
    ),
  ),
) {}
