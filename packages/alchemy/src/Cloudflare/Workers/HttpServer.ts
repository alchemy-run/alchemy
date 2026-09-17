import type * as cf from "@cloudflare/workers-types";
import type * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Cookies from "effect/unstable/http/Cookies";
import * as Headers from "effect/unstable/http/Headers";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";
import type { WorkerServices } from "./Worker.ts";
import { isWorkerEvent } from "./WorkerRuntime.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const makeRequestHandler =
  <Req = never>(
    handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
  ) =>
  (event: any) =>
    isWorkerEvent(event) && event.type === "fetch"
      ? makeRequestEffect(event.input, handler)
      : undefined;

export const makeRequestEffect = <Req = never>(
  webRequest: cf.Request,
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
) => {
  // Adoption runs on the handler's own result, before `toHandled` applies
  // the request's pre-response handlers, so those see and mutate the status
  // and headers the native response carries.
  const safeHandler = Effect.map(
    Http.safeHttpEffect(handler),
    adoptWebResponse,
  );
  return Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(
      webRequest as any as globalThis.Request,
    ).modify({
      remoteAddress: Option.fromUndefinedOr(
        webRequest.headers.get("cf-connecting-ip") ?? undefined,
      ),
    });

    Object.defineProperty(request, "raw", {
      get: () =>
        Object.assign(request.stream, {
          raw: webRequest.body,
        }),
    });

    return yield* toHandledWebResponse(safeHandler).pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
        Layer.succeed(Request, webRequest as any),
      ]),
    );
  }) as any;
};

const toHandledWebResponse = <Req>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Req>,
) =>
  Effect.gen(function* () {
    // `toHandled` exposes the final response through this callback, not its
    // return value. Keep the assignment isolated here so callers get Response.
    const context = yield* Effect.context();
    const webResponse = yield* Deferred.make<Response>();

    yield* EffectHttp.toHandled(handler, (request, response) =>
      Deferred.succeed(
        webResponse,
        // Conversion to web response with options matches `EffectHttp.toWebHandler`'s callback.
        toWeb(EffectHttp.scopeTransferToStream(response), {
          withoutBody: request.method === "HEAD",
          context,
        }),
      ),
    );
    return yield* Deferred.await(webResponse);
  });

/**
 * The web `Response` a `Raw` body carries, if that is what it carries.
 */
const rawWebResponse = (
  response: HttpServerResponse.HttpServerResponse,
): Response | undefined =>
  response.body._tag === "Raw" && response.body.body instanceof Response
    ? response.body.body
    : undefined;

/**
 * Lifts the status, status text and headers of a Raw web `Response` into the
 * `HttpServerResponse` that carries it.
 *
 * `HttpServerResponse.raw(new Response(...))` describes its response as a
 * 200 with no headers; the values the client will see live on the native
 * object. Adopting them makes the Effect-level fields the response's fields:
 * a pre-response handler reads the real status, and whatever it sets is a
 * difference `toWeb` applies to the native object, on GET and HEAD alike.
 * Headers the `HttpServerResponse` already carries (a `contentType` option,
 * headers passed to `raw`) keep overriding the native ones by name, as
 * `HttpServerResponse.toWeb` has always applied them. `Set-Cookie` stays on
 * the native object, where its multiplicity is kept; cookies added at the
 * Effect level are appended on output.
 */
const adoptWebResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const body = response.body;
  if (body._tag !== "Raw" || !(body.body instanceof Response)) return response;
  const native = body.body;
  return HttpServerResponse.raw(native, {
    status: native.status,
    statusText: native.statusText || undefined,
    headers: Headers.merge(
      Headers.fromInput(nativeHeaderEntries(native)),
      response.headers,
    ),
    cookies: response.cookies,
    contentType: body.contentType,
    contentLength: body.contentLength,
  });
};

/** The native header list without its `Set-Cookie` entries. */
function* nativeHeaderEntries(
  native: Response,
): Iterable<readonly [string, string]> {
  for (const entry of native.headers) {
    if (entry[0] !== "set-cookie") yield entry;
  }
}

/**
 * `HttpServerResponse.toWeb`, except that a Raw web `Response` answers with
 * the Effect-level status, status text, headers and cookies on every method.
 *
 * `HttpServerResponse.toWeb` hands a Raw web `Response` to the client as the
 * object it is, so the Effect-level status is dropped on GET while the HEAD
 * path (`withoutBody`) builds a fresh response from it. Here both methods
 * take the native object as the baseline and apply what differs from it:
 *
 * - Nothing differs (the common case after `adoptWebResponse`): the native
 *   object is returned untouched, so its identity, its body and any
 *   Workers-only construction options survive.
 * - A 101 is always returned untouched. An upgrade response is bound to its
 *   socket and cannot be rebuilt.
 * - Otherwise a new `Response` is built over the same body stream, which is
 *   neither read nor copied, with the Effect-level status and headers. The
 *   native `Set-Cookie` list keeps its multiplicity; Effect-level headers
 *   override native ones by name; Effect-level cookies are appended.
 * - A body that must be omitted (HEAD, 204, 205, 304) is cancelled without
 *   being awaited, as `HttpServerResponse.toWeb` does for raw streams.
 */
const toWeb = (
  response: HttpServerResponse.HttpServerResponse,
  options: {
    readonly withoutBody: boolean;
    readonly context: Context.Context<never>;
  },
): Response => {
  const native = rawWebResponse(response);
  if (native === undefined) return HttpServerResponse.toWeb(response, options);
  if (native.status === 101) return native;
  const omitBody = HttpServerResponse.omitsBody(response, options.withoutBody);
  if (isUnchanged(response, native) && (!omitBody || native.body === null)) {
    return native;
  }
  const headers = new globalThis.Headers();
  for (const [name, value] of native.headers) {
    if (name === "set-cookie") headers.append(name, value);
  }
  for (const [name, value] of Object.entries(response.headers)) {
    headers.set(name, value);
  }
  for (const cookie of Cookies.toSetCookieHeaders(response.cookies)) {
    headers.append("set-cookie", cookie);
  }
  if (omitBody) native.body?.cancel().catch(constVoid);
  return new Response(omitBody ? null : native.body, {
    status: response.status,
    // A status text adopted from the native object describes the native
    // status; when only the status changed, let the runtime name the new one.
    statusText:
      response.statusText !== undefined &&
      response.statusText !== "" &&
      (response.status === native.status ||
        response.statusText !== native.statusText)
        ? response.statusText
        : undefined,
    headers,
  });
};

/**
 * Whether the Effect-level status, status text, headers and cookies are the
 * ones the native object already carries, so it can answer as it is.
 */
const isUnchanged = (
  response: HttpServerResponse.HttpServerResponse,
  native: Response,
): boolean => {
  if (
    response.status !== native.status ||
    (response.statusText !== undefined &&
      response.statusText !== native.statusText) ||
    !Cookies.isEmpty(response.cookies)
  ) {
    return false;
  }
  let count = 0;
  for (const [name, value] of native.headers) {
    if (name === "set-cookie") continue;
    if (response.headers[name] !== value) return false;
    count++;
  }
  return count === Object.keys(response.headers).length;
};

export { isScopeEjected } from "../../Http.ts";
