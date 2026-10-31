import type * as cf from "@cloudflare/workers-types";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectHttp from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";

/**
 * Run an Effect HTTP handler against a workerd `Request` and resolve the
 * web `Response` it produces. The handler sees the request both as Effect's
 * `HttpServerRequest` and as the raw web {@link Request}.
 */
export const makeRequestEffect = <Req = never>(
  webRequest: cf.Request,
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
) => {
  const safeHandler = Http.safeHttpEffect(handler);
  return Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(webRequest as any as globalThis.Request).modify({
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

    yield* EffectHttp.toHandled(handler, (request, response) => {
      const withoutBody = request.method === "HEAD";
      if (!HttpServerResponse.omitsBody(response, withoutBody)) {
        response = EffectHttp.scopeTransferToStream(response);
      }
      return Deferred.succeed(
        webResponse,
        HttpServerResponse.toWeb(response, { withoutBody, context }),
      );
    });
    return yield* Deferred.await(webResponse);
  });
