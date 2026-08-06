/**
 * The Fleet's runtime context: the Cloudflare Worker runtime context (a
 * Celld fleet deploys a real Worker bundle, so the serve/export/env
 * machinery is identical) with two fleet-specific behaviors layered on:
 *
 * 1. Every served `fetch` handler is wrapped with the RPC gateway
 *    ({@link makeGatewayFetch}) so cells are addressable over HTTP.
 * 2. A fleet whose impl returns `{}` (pure DO host, no user routes) still
 *    serves — the gateway self-registers before `exports` is read, so the
 *    deployed Worker always has a default `fetch`.
 */
import * as Effect from "effect/Effect";
import { WorkerTypeId } from "./FleetTypes.ts";
import {
  makeWorkerRuntimeContext,
  type WorkerRuntimeContext,
} from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { makeGatewayFetch } from "./FleetGateway.ts";

export interface FleetRuntimeContext extends WorkerRuntimeContext {}

export const makeFleetRuntimeContext = (id: string): FleetRuntimeContext => {
  const base = makeWorkerRuntimeContext(id);
  let served = false;

  const serve: WorkerRuntimeContext["serve"] = (handler, options) => {
    served = true;
    return base.serve(makeGatewayFetch(handler as any) as any, options);
  };

  return {
    ...base,
    // `makeWorkerRuntimeContext` stamps `Type: "Cloudflare.Worker"`; the
    // context is `Object.assign`ed onto the resource instance, so the base
    // Type would clobber the Celld Worker's — and Cloudflare's
    // `isWorker(worker)` must be false.
    Type: WorkerTypeId as any,
    serve,
    exports: Effect.gen(function* () {
      if (!served) {
        served = true;
        yield* base.serve(makeGatewayFetch(undefined) as any);
      }
      return yield* base.exports;
    }),
  };
};
