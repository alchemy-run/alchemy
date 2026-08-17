import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";
// `isWorkerEvent` comes from the RuntimeEnvironment leaf (NOT Worker.ts):
// this module is compiled by foreign bundlers through the serve bridge, and
// Worker.ts's provider graph reaches the workerd native binary. The
// `WorkerServices` import is type-only (erased).
import { isWorkerEvent } from "./RuntimeEnvironment.ts";
import type { WorkerServices } from "./Worker.ts";

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

    return yield* Http.toHandledWebResponse(safeHandler).pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
        Layer.succeed(Request, webRequest as any),
      ]),
    );
  }) as any;
};

export { isScopeEjected } from "../../Http.ts";
