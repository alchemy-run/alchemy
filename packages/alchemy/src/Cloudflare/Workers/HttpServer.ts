import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";
import { isWorkerEvent, type WorkerServices } from "./Worker.ts";

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
): Effect.Effect<
  Response,
  never,
  Exclude<Req, HttpServerRequest.HttpServerRequest | Scope>
> => {
  const safeHandler = Http.safeHttpEffect(handler);
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

    const response = yield* safeHandler.pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
        Layer.succeed(Request, webRequest as any),
      ]),
      Effect.catchCause((cause) => {
        const message = Option.match(Cause.findErrorOption(cause), {
          onNone: () => "Internal Server Error",
          onSome: (error: any) =>
            error instanceof Error && error.message
              ? error.message
              : "Internal Server Error",
        });
        return Effect.succeed(
          HttpServerResponse.text(message, {
            status: 500,
            statusText: message,
          }),
        );
      }),
    );

    return HttpServerResponse.toWeb(response);
  }) as any;
};
