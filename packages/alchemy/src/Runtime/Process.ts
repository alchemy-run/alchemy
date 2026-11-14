import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { HttpEffect } from "../Http.ts";
import * as Http from "../Http.ts";
import * as Output from "../Output.ts";
import { packEnvValue, unpackEnvValue, type BaseRuntimeContext } from "../RuntimeContext.ts";
import { serveSandboxAgent, type SandboxAgentConfig } from "../SandboxAgent.ts";
import { SANDBOX_IDLE_TIMEOUT_ENV, SANDBOX_TOKEN_ENV } from "../SandboxAgentClient.ts";
import { ManagedHttpShutdown } from "./ManagedHttpShutdown.ts";

export type ProcessServices = ChildProcessSpawner | FileSystem | Path | Stdio | Terminal;

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
 * can `yield* ServerHost` and call `host.run(...)` during plan/deploy without
 * the caller providing the layer itself.
 */
export class ServerHost extends Context.Service<ServerHost, Pick<ProcessContext, "run">>()(
  "Alchemy::ServerHost",
) {}

/**
 * Claims an inbound HTTP request before the program's own `fetch` handler
 * sees it (a webhook delivery, a push subscription, ...). Return `undefined`
 * to pass the request on to the next listener and finally to `fetch`.
 */
export type HttpListener = (
  request: HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, any> | undefined;

/**
 * Deploy-time / plan-time host context for platforms that bundle a long-lived
 * program. It collects background work registered via `run` and HTTP handlers
 * registered via `serve` into a single `exports.program` effect that the
 * generated container/instance entrypoint runs.
 */
export interface HostRuntimeContext extends ProcessContext {
  /**
   * Register a listener that sees every request before the served handler,
   * the counterpart of `host.listen` on a Cloudflare Worker. Listeners are
   * read per request, so it does not matter whether they register before or
   * after `serve`. A program that registers a listener but serves no `fetch`
   * still boots the HTTP server. Hosts built by
   * {@link createHostRuntimeContext} have it.
   */
  listen?: (listener: HttpListener) => Effect.Effect<void>;
  serve: <Req = never>(
    handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
    options?: { shape?: Record<string, unknown> },
  ) => Effect.Effect<void, never, Req>;
  exports: Effect.Effect<{
    readonly program: Effect.Effect<void, never, any>;
  }>;
}

/**
 * Build a {@link HostRuntimeContext} for a hosted platform of the given
 * resource `type`. Both `run` (background loops) and `serve` (HTTP handlers)
 * append to a single list of runners; `exports.program` runs them all
 * concurrently. This is the shared host context used by `AWS.EC2.Instance` and
 * `AWS.ECS.Task`. Managed Fly shutdown gives each runner a sequential resource
 * scope; runner scopes close concurrently while HTTP and shared dependencies live.
 * A shutdown signal starts an independent deadline, including for application-owned
 * scopes. Without a signal, a nested `Effect.scoped` runner must finish its own
 * finalizers before the host can observe completion or failure. Applications must
 * bound that cleanup; the host cannot observe an opaque scope's earlier body exit.
 */
export const createHostRuntimeContext =
  (type: string) =>
  (id: string): HostRuntimeContext => {
    const runners: Effect.Effect<void, never, any>[] = [];
    const env: Record<string, any> = {};
    const listeners: HttpListener[] = [];
    let served = false;
    // Listeners run first, per request; an unclaimed request reaches the
    // handler unchanged, so a host with no listener serves as before.
    const dispatch = (handler: HttpEffect<any>): HttpEffect<any> =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        for (const listener of listeners) {
          const claimed = listener(request);
          if (claimed !== undefined) return yield* claimed;
        }
        return yield* handler;
      });

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
        // this must never resolve through `Config.String`.
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- must read process.env directly, never through Config (see unpackEnvValue)
        Effect.sync(() => unpackEnvValue<T>(process.env[key]) as T),
      run: (effect: Effect.Effect<void, never, any>) =>
        Effect.sync(() => {
          runners.push(effect);
        }),
      listen: (listener: HttpListener) =>
        Effect.sync(() => {
          listeners.push(listener);
        }),
      serve: ((handler) =>
        Effect.sync(() => {
          served = true;
          // Register the HTTP handler as a runner. At container runtime the
          // ambient `HttpServer` (if provided) serves it; `Http.serve` is a
          // no-op when no server is bound, so this never crashes plan/deploy.
          runners.push((handler as HttpEffect<any>).pipe(dispatch, Http.serve));
        })) as HostRuntimeContext["serve"],
      exports: Effect.sync(() => {
        // A program that only consumes events has no `fetch`, so nothing
        // called `serve`: boot the server for its listeners.
        if (!served && listeners.length > 0) {
          served = true;
          runners.push(
            HttpServerResponse.text("Not Found", { status: 404 }).pipe(
              Effect.succeed,
              dispatch,
              Http.serve,
            ),
          );
        }
        return {
          program: Effect.serviceOption(ManagedHttpShutdown).pipe(
            Effect.flatMap((managed) => {
              let remaining = runners.length;
              return Effect.all(
                Option.isSome(managed)
                  ? runners.map((runner) =>
                      runner.pipe(
                        Effect.onExit((exit) =>
                          Effect.sync(() => managed.value.runnerFinished(exit, --remaining === 0)),
                        ),
                        Effect.scoped,
                        // Parent interruption may discard child finalizer defects.
                        Effect.onExit((exit) =>
                          Effect.sync(() => managed.value.runnerFinished(exit, false)),
                        ),
                      ),
                    )
                  : runners,
                { concurrency: "unbounded" },
              );
            }),
          ),
        };
      }),
    } satisfies HostRuntimeContext;
  };

/**
 * Host runtime context for container platforms (`AWS.ECS.Task`,
 * `AWS.ECS.Service`, `Docker.Service`): extends the shared process host
 * context so an impl shape's `run` effect is registered as a one-shot runner
 * (the container exits when it completes) and the HTTP server only boots when
 * the impl actually declares a `fetch` handler.
 *
 * A container started as a sandbox (its environment carries a sandbox token,
 * set by a binding such as `AWS.ECS.CreateSandbox`) always serves: the
 * program's methods and the sandbox agent's `exec`, `files` and `pty` answer
 * as RPC on the program's port, and each call needs the token.
 */
export const createContainerRuntimeContext =
  (type: string) =>
  (id: string): HostRuntimeContext => {
    const base = createHostRuntimeContext(type)(id);
    const sandbox = sandboxAgentConfig();
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
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `run` is a user program; the host runner surfaces its failures
          yield* base.run(run as Effect.Effect<void, never, any>);
        }
        if (sandbox !== undefined) {
          const { run: _run, fetch: _fetch, ...methods } = shape ?? {};
          // The agent is built by the running program, where the platform's
          // process and filesystem services are in context.
          yield* base.run(
            Effect.flatMap(
              serveSandboxAgent(sandbox, methods, Http.safeHttpEffect(handler)),
              Http.serve,
            ),
          );
          return;
        }
        // Boot the HTTP server only for an impl that declared `fetch` — a
        // pure one-shot `{ run }` program must exit when `run` completes
        // rather than parking behind the 404 fallback server forever.
        if (shape === undefined || shape.fetch !== undefined) {
          yield* serveBase(handler, options);
        }
      }) as Effect.Effect<void, never, never>;
    // A sandbox serves the agent even when its program returns nothing.
    return Object.assign(base, { serve }, sandbox !== undefined ? { alwaysServe: true } : {});
  };

/**
 * The sandbox settings a binding passed this container when it started it.
 * Only a running container has them: a plan or deploy never serves the agent.
 */
const sandboxAgentConfig = (): SandboxAgentConfig | undefined => {
  if (!globalThis.__ALCHEMY_RUNTIME__) return undefined;
  // The token arrives as a plain per-task environment override, so it is read
  // from the process, not through Config.
  const token = process.env[SANDBOX_TOKEN_ENV];
  if (token === undefined || token === "") return undefined;
  const idleTimeoutMs = Number(process.env[SANDBOX_IDLE_TIMEOUT_ENV]);
  return {
    token,
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : undefined,
  };
};
