/**
 * The generic worker's runtime context: the Cloudflare Worker runtime
 * context (every engine deploys the same Worker-bundle artifact, so the
 * serve/export/env machinery is shared) with the engine-specific behaviors
 * deferred to the {@link WorkerTarget} recorded during the impl's init:
 *
 * - the target's `wrapServe` (e.g. celld's RPC gateway) is applied when
 *   `exports` is assembled — after the impl (and its target layer) ran —
 *   so the wrap composes identically on plan and runtime evaluations;
 * - the target's `props` are folded onto the resource's persisted Props
 *   via {@link BaseRuntimeContext.foldProps}.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import type { HttpEffect } from "../Http.ts";
import {
  makeWorkerRuntimeContext,
  type WorkerRuntimeContext,
} from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import type { WorkerTargetService } from "./Engine.ts";
import { WorkerTypeId } from "./Worker.ts";

export interface GenericWorkerRuntimeContext extends WorkerRuntimeContext {
  /** Recorded by the target layer during the impl's init. @internal */
  target?: WorkerTargetService;
}

export const makeGenericWorkerRuntimeContext = (
  id: string,
): GenericWorkerRuntimeContext => {
  const base = makeWorkerRuntimeContext(id);
  let served: HttpEffect<any> | undefined;
  let servedOptions: { shape?: Record<string, unknown> } | undefined;
  let hasServed = false;
  let registered = false;

  const ctx: GenericWorkerRuntimeContext = {
    ...base,
    // `makeWorkerRuntimeContext` stamps `Type: "Cloudflare.Worker"`; the
    // context is `Object.assign`ed onto the resource instance, so the base
    // Type would clobber the generic worker's.
    Type: WorkerTypeId as any,
    target: undefined,
    serve: ((handler: any, options?: { shape?: Record<string, unknown> }) => {
      // Defer the actual registration to `exports` so the target's
      // `wrapServe` — recorded while the impl's layers built — can wrap
      // the handler.
      served = handler;
      servedOptions = options;
      hasServed = true;
      return Effect.void as any;
    }) as WorkerRuntimeContext["serve"],
    exports: Effect.gen(function* () {
      // `exports` is evaluated once per export by the runtime bridge (the
      // default worker AND every Durable Object class) — the listener
      // registration must be idempotent or the dispatcher sees duplicate
      // handlers and discards the response.
      if (!registered) {
        registered = true;
        const wrap = ctx.target?.wrapServe;
        const handler = wrap ? wrap(served) : served;
        if (handler !== undefined || hasServed || wrap !== undefined) {
          yield* base.serve(handler as any, servedOptions);
        }
      }
      return yield* base.exports;
    }),
    foldProps: (props: Record<string, unknown>) =>
      ctx.target === undefined
        ? props
        : {
            ...props,
            target: { kind: ctx.target.kind, props: ctx.target.props },
          },
  };
  return ctx;
};
