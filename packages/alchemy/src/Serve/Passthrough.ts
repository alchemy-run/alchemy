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
 * Decline the current request: the framework's own fetch handler serves
 * it. This is the typed "not mine" signal of an effectful Website's
 * `fetch` — the serve bridge maps the failure to delegation, so the
 * framework (or, on a StaticSite, the asset layer) answers instead. It
 * is never 404-sniffing: a handler that matched and chose 404 returns a
 * real 404 response.
 *
 * `passthrough` fails with {@link Passthrough}, a subclass of
 * `HttpRouter`'s `RouteNotFound` — both spellings ride one protocol, so
 * an `HttpRouter`-built fetch gets passthrough for free on unmatched
 * routes.
 *
 * @binding
 * @product Serve
 *
 * @section Declining a request
 * @example Hand-rolled fetch with passthrough
 * ```typescript
 * import { passthrough } from "alchemy/serve";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * const fetch = Effect.gen(function* () {
 *   const request = yield* HttpServerRequest;
 *   const url = new URL(request.url, "http://localhost");
 *   if (url.pathname === "/api/user") {
 *     return yield* HttpServerResponse.json({ name: "sam" });
 *   }
 *   // Not ours — the framework serves it.
 *   return yield* passthrough;
 * });
 * ```
 */
export const passthrough: Effect.Effect<never, Passthrough, HttpServerRequest> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    return yield* Effect.fail(
      new Passthrough({ request, description: "alchemy/serve passthrough" }),
    );
  });
