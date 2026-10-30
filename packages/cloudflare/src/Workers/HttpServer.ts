import * as Http from "alchemy/Http";
import { makeRequestEffect } from "alchemy/Workers/Workerd/HttpServer";
import type * as Effect from "effect/Effect";
import type { WorkerServices } from "./Worker.ts";
import { isWorkerEvent } from "./WorkerRuntime.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const makeRequestHandler =
  <Req = never>(handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>) =>
  (event: any) =>
    isWorkerEvent(event) && event.type === "fetch"
      ? makeRequestEffect(event.input, handler)
      : undefined;

export { makeRequestEffect };
export { isScopeEjected } from "alchemy/Http";
