import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Portless from "@alchemy.run/portless";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Api } from "./api.ts";

/**
 * An Effect-native Worker that calls the `Api` dev service through
 * `Portless.Fetch`: a relative URL, resolved against the service's origin,
 * over HTTPS that the Worker verifies with the Portless CA.
 */
export default class EffectCaller extends Cloudflare.Worker<EffectCaller>()(
  "PortlessEffectCaller",
  { main: import.meta.url },
  Effect.gen(function* () {
    const api = yield* Portless.Fetch(Api);

    return {
      fetch: Effect.gen(function* () {
        const response = yield* api(HttpClientRequest.get("/hello"));
        return HttpServerResponse.text(yield* response.text, { status: response.status });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`caller failed: ${String(cause)}`, { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Portless.FetchHttp)),
) {}
