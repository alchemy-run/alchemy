import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import type { FunctionContext, FunctionListener } from "../../Runtime/Function.ts";
import { packEnvValueKeepRedacted, unpackEnvValue } from "../../RuntimeContext.ts";
import { WorkerEnvironment } from "../WorkerEnvironment.ts";
import { makeRequestEffect } from "./HttpServer.ts";
import { ExportedHandlerMethods, isWorkerEvent, type WorkerEvent } from "./WorkerEvent.ts";

/** Something a hosted class or capture exports onto its Worker's bundle. */
export interface WorkerExportLike {
  readonly kind: string;
}

/** The engine-specific half of a Worker runtime context. */
export interface WorkerRuntimeContextOptions {
  /** The Worker resource type (e.g. `Cloudflare.Worker`). */
  readonly type: string;
  /** Services the host provides its init in every phase. */
  readonly hostServices?: Layer.Layer<any, never, any> | undefined;
}

const makeRequestHandler =
  <Req = never>(handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>) =>
  (event: any) =>
    isWorkerEvent(event) && event.type === "fetch"
      ? makeRequestEffect(event.input, handler)
      : undefined;

export interface WorkerRuntimeContext extends FunctionContext {
  export(name: string, value: any): Effect.Effect<void>;
  shape: () => Record<string, any>;
}

export const makeWorkerRuntimeContext = (
  id: string,
  options: WorkerRuntimeContextOptions,
): WorkerRuntimeContext => {
  const listeners: Effect.Effect<FunctionListener>[] = [];
  const exports: Record<string, WorkerExportLike> = {};
  const env: Record<string, any> = {};
  let userShape: Record<string, unknown> | undefined;

  const ctx = {
    Type: options.type,
    id,
    env,
    shape: () => userShape!,
    get: (key: string) =>
      Effect.serviceOption(WorkerEnvironment).pipe(
        Effect.map(Option.getOrUndefined),
        // Key is already canonical (see RuntimeContext.sanitizeKey). Read
        // straight from `WorkerEnvironment` — see `unpackEnvValue` for why
        // this must never resolve through `Config.String`.
        Effect.map((env) => unpackEnvValue(env?.[key])),
      ) as any,
    set: (key: string, output: Output.Output) =>
      Effect.sync(() => {
        // `packEnvValueKeepRedacted` keeps the Redacted wrapper on the
        // outside so the put-worker loop can deploy secrets via
        // `secret_text` instead of leaking them as `plain_text`, while the
        // inner marker lets the runtime `get` accessor rebuild the wrapper
        // after Cloudflare hands the binding back as a plain string.
        env[key] = output.pipe(Output.map(packEnvValueKeepRedacted));
        return key;
      }),
    serve: <Req = never>(
      handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
      options?: { shape?: Record<string, unknown> },
    ) => {
      // Capture the user's full default-export shape so `exports` can
      // expose any non-handler methods on it as RPC methods on the
      // deployed `WorkerEntrypoint` subclass — see `__rpc__` below.
      if (options?.shape) userShape = options.shape;
      return ctx.listen(makeRequestHandler(handler));
    },
    listen: ((handler: FunctionListener | Effect.Effect<FunctionListener>) =>
      Effect.sync(() =>
        Effect.isEffect(handler)
          ? listeners.push(handler)
          : listeners.push(Effect.succeed(handler)),
      )) as any as FunctionContext["listen"],
    export: (name: string, value: any) =>
      Effect.sync(() => {
        exports[name] = value;
      }),
    hostServices: options.hostServices,
    planServices: Layer.mergeAll(Layer.succeed(WorkerEnvironment, {})),
    exports: Effect.gen(function* () {
      const handlers = yield* Effect.all(listeners, {
        concurrency: "unbounded",
      });
      const services = yield* Effect.context();

      const dispatch =
        (type: WorkerEvent["type"]) =>
        (request: any, env: unknown, context: cf.ExecutionContext) => {
          const event: WorkerEvent = {
            kind: "Cloudflare.Workers.WorkerEvent",
            type,
            input: request,
            env,
            context,
          };
          const effects: Effect.Effect<unknown>[] = [];
          for (const handler of handlers) {
            const eff = handler(event);
            if (Effect.isEffect(eff)) {
              effects.push(eff);
            }
          }
          if (effects.length === 1) {
            return [effects[0], services];
          }
          if (effects.length > 1) {
            return [
              Effect.all(effects, { concurrency: "unbounded" }).pipe(
                Effect.map((results) => {
                  for (const result of results) {
                    if (result instanceof Response) return result;
                  }
                  return results[results.length - 1];
                }),
              ),
              services,
            ];
          }
          return [
            Effect.die(new Error(`No event handler found for event type '${type}'`)),
            services,
          ];
        };

      // RPC method dispatchers — one per non-handler method on the user's
      // shape. Each dispatcher is invoked by the WorkerEntrypoint bridge
      // as `dispatcher(args, ctx)`: `args` are the user-facing call args,
      // `ctx` is the `this.ctx` that Cloudflare hands the bridge per RPC
      // request. The dispatcher runs the user effect with the same runtime
      // layer the fetch path uses, then envelope-encodes the result so
      // `Effect.fail` round-trips as `RpcErrorEnvelope` and `Stream` as
      // `RpcStreamEnvelope` (consumers wrap the binding with
      // `toRpcAsync`/`bindWorker` to decode).

      return {
        ...exports,
        default: Object.fromEntries(
          ExportedHandlerMethods.map((method) => [method, dispatch(method)]),
        ),
      };
    }),
  };
  return ctx;
};
