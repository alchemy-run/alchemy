import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";

/**
 * Typed "this request is not mine" signal for hand-rolled fetch effects.
 *
 * Extends `HttpRouter`'s `RouteNotFound` so both spellings ride ONE
 * passthrough protocol — the bridge maps a `RouteNotFound` failure to
 * delegation (the framework handles the request), never 404-sniffing: a
 * handler that matched and chose 404 returns a real 404 response. Sharing
 * the tag also keeps a fetch effect that yields {@link passthrough}
 * assignable to the Worker shape's `HttpEffect` error union, and means
 * `HttpRouter` users get passthrough for free.
 */
export class Passthrough extends RouteNotFound {}

/**
 * Decline the current request: the framework's own fetch handler serves it.
 *
 * ```ts
 * fetch: Effect.gen(function* () {
 *   const request = yield* HttpServerRequest;
 *   if (!request.url.startsWith("/api/")) return yield* Serve.passthrough;
 *   // ...
 * })
 * ```
 */
export const passthrough: Effect.Effect<never, Passthrough, HttpServerRequest> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    return yield* Effect.fail(
      new Passthrough({ request, description: "alchemy/serve passthrough" }),
    );
  });
