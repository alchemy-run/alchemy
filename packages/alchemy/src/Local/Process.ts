import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Option from "effect/Option";
import type { Path } from "effect/Path";
import { Scope } from "effect/Scope";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { HttpEffect } from "../Http.ts";
import * as Http from "../Http.ts";
import * as Output from "../Output.ts";
import {
  packEnvValue,
  unpackEnvValue,
  type BaseRuntimeContext,
} from "../RuntimeContext.ts";
import { withStaticAssets } from "./Assets.ts";

export type ProcessServices =
  | ChildProcessSpawner
  | FileSystem
  | Path
  | Stdio
  | Terminal;

export interface ProcessContext extends BaseRuntimeContext {
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}

/**
 * Long-running host loop registration (`run`). Provided by `Platform` when the
 * execution context implements {@link ProcessContext} (i.e. carries `run`).
 *
 * `Platform` wires this automatically for every host runtime context that
 * implements `run` (EC2 instances, ECS tasks, processes), so an inline program
 * can `yield* Host` and call `host.run(...)` during plan/deploy without
 * the caller providing the layer itself.
 */
export class Host extends Context.Service<Host, Pick<ProcessContext, "run">>()(
  "Alchemy::Host",
) {}

/**
 * Register a long-running effect on {@link Host} when one is in the ambient
 * context (Platform process constructors — Local.Service, EC2, ECS, …).
 * `Host.run` collects runners that start with `exports.program`, so this is
 * for work discovered during init (pollers, event sources), not work that
 * starts later in a request.
 *
 * Without Host (unit tests), forks into the ambient Scope so an
 * `Effect.provide` wrapping the test body owns the fiber for the test.
 */
export const runOnHost = <R>(
  effect: Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R | Scope> =>
  Effect.gen(function* () {
    const host = yield* Effect.serviceOption(Host);
    if (Option.isSome(host)) {
      yield* host.value.run(effect as Effect.Effect<void, never, never>);
      return;
    }
    const scope = yield* Effect.scope;
    yield* Effect.forkIn(effect, scope);
  }).pipe(Effect.asVoid);

/**
 * A Scope that outlives an `Effect.provide` of the constructing layer —
 * for fibers that start AFTER init (kernel run loops, socket serves,
 * deferred reviews).
 *
 * When {@link Host} is present, registers a keeper on the host at build
 * time; the Scope opens when `exports.program` runs and stays open for
 * the process. {@link ProcessScope.fork} awaits that Scope, so the first
 * post-init fork races cleanly with the keeper.
 *
 * Without Host (unit tests), forks into the ambient Scope so the
 * `Effect.provide` wrapping the test body owns the fibers.
 */
export interface ProcessScope {
  readonly fork: (effect: Effect.Effect<void, never>) => Effect.Effect<void>;
}

export const makeProcessScope: Effect.Effect<ProcessScope, never, Scope> =
  Effect.gen(function* () {
    const host = yield* Effect.serviceOption(Host);
    if (Option.isNone(host)) {
      const scope = yield* Effect.scope;
      return {
        fork: (effect) => Effect.asVoid(Effect.forkIn(effect, scope)),
      } satisfies ProcessScope;
    }
    // Capture the process root Scope when exports.program starts (the
    // entry's Effect.scoped region). No forever-park needed — that
    // Scope outlives every runner.
    const ready = yield* Deferred.make<Scope>();
    yield* host.value.run(
      Effect.gen(function* () {
        yield* Deferred.succeed(ready, yield* Effect.scope);
      }).pipe(Effect.orDie),
    );
    return {
      fork: (effect) =>
        Effect.gen(function* () {
          const scope = yield* Deferred.await(ready);
          yield* Effect.forkIn(effect, scope);
        }).pipe(Effect.asVoid),
    } satisfies ProcessScope;
  });

/**
 * Deploy-time / plan-time host context for platforms that bundle a long-lived
 * program. It collects background work registered via `run` and HTTP handlers
 * registered via `serve` into a single `exports.program` effect that the
 * generated container/instance entrypoint runs.
 */
export interface HostRuntimeContext extends ProcessContext {
  serve: <Req = never>(
    handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
    options?: { shape?: Record<string, unknown> },
  ) => Effect.Effect<void, never, Req>;
  exports: Effect.Effect<{
    readonly program: Effect.Effect<void, never, any>;
    /**
     * Whether the constructor registered an HTTP handler (`fetch` or RPC
     * shape). Recorded in props at plan time so providers know to expect
     * the runtime to bind a port and report it back.
     */
    readonly serves: boolean;
  }>;
}

/**
 * Build a {@link HostRuntimeContext} for a hosted platform of the given
 * resource `type`. Both `run` (background loops) and `serve` (HTTP handlers)
 * append to a single list of runners; `exports.program` runs them all
 * concurrently. This is the shared host context used by `AWS.EC2.Instance` and
 * `AWS.ECS.Task`.
 */
export const createHostRuntimeContext =
  (type: string) =>
  (id: string): HostRuntimeContext => {
    const runners: Effect.Effect<void, never, any>[] = [];
    const env: Record<string, any> = {};
    let serves = false;

    return {
      Type: type,
      id,
      env,
      set: (bindingId: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
          // `packEnvValue` marker-packs Redacted values so they survive the
          // Output → env round-trip.
          env[key] = output.pipe(Output.map(packEnvValue));
          return key;
        }),
      get: <T>(key: string) =>
        // Read straight from `process.env` — see `unpackEnvValue` for why
        // this must never resolve through `Config.string`.
        Effect.sync(() => unpackEnvValue<T>(process.env[key]) as T),
      run: (effect: Effect.Effect<void, never, any>) =>
        Effect.sync(() => {
          runners.push(effect);
        }),
      serve: ((handler) =>
        Effect.sync(() => {
          // Register the HTTP handler as a runner. At container runtime the
          // ambient `HttpServer` (if provided) serves it; `Http.serve` is a
          // no-op when no server is bound, so this never crashes plan/deploy.
          // `withStaticAssets` serves a built SPA around the handler when
          // the host ships one (ALCHEMY_SERVICE_ASSETS) — pass-through
          // otherwise.
          serves = true;
          runners.push(
            Http.serve(withStaticAssets(handler as HttpEffect<any>)),
          );
        })) as HostRuntimeContext["serve"],
      exports: Effect.sync(() => ({
        program: Effect.all(runners, { concurrency: "unbounded" }),
        serves,
      })),
    } satisfies HostRuntimeContext;
  };

/**
 * Host runtime context for container platforms (`AWS.ECS.Task`,
 * `AWS.ECS.Service`, `Docker.Service`): extends the shared process host
 * context so an impl shape's `run` effect is registered as a one-shot runner
 * (the container exits when it completes) and the HTTP server only boots when
 * the impl actually declares a `fetch` handler.
 */
export const createContainerRuntimeContext =
  (type: string) =>
  (id: string): HostRuntimeContext => {
    const base = createHostRuntimeContext(type)(id);
    // Capture the host serve BEFORE Object.assign overwrites `base.serve`
    // with the wrapper below — calling `base.serve` inside the wrapper would
    // resolve to the wrapper itself (property lookup happens at call time)
    // and recurse without bound the moment an impl declares `fetch`.
    const serveBase = base.serve;
    const serve: HostRuntimeContext["serve"] = (handler, options) =>
      Effect.gen(function* () {
        const shape = options?.shape;
        const run = shape?.run;
        if (Effect.isEffect(run)) {
          yield* base.run(run as Effect.Effect<void, never, any>);
        }
        // Boot the HTTP server only for an impl that declared `fetch` — a
        // pure one-shot `{ run }` program must exit when `run` completes
        // rather than parking behind the 404 fallback server forever.
        if (shape === undefined || shape.fetch !== undefined) {
          yield* serveBase(handler, options);
        }
      }) as Effect.Effect<void, never, never>;
    return Object.assign(base, { serve });
  };
