import type * as cf from "@cloudflare/workers-types";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer, type HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { Platform } from "../../Platform.ts";
import * as Server from "../../Server/index.ts";
import type { Fetcher } from "../Fetcher.ts";
import type {
  ContainerApplication,
  ContainerApplicationProps,
  ContainerServices,
  ContainerShape,
} from "./ContainerApplication.ts";
import { bindContainer } from "./ContainerBinding.ts";

export const ContainerTypeId = "Cloudflare.Container";
export type ContainerTypeId = typeof ContainerTypeId;

export const isContainer = <T>(value: T): value is T & Container =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === ContainerTypeId;

export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ContainerStartupOptions extends cf.ContainerStartupOptions {}

export interface ContainerProps extends ContainerApplicationProps {
  main: string;
}

export type Container = {
  get running(): Effect.Effect<boolean>;
  start(options?: ContainerStartupOptions): Effect.Effect<void>;
  monitor(): Effect.Effect<void, ContainerError>;
  destroy(error?: any): Effect.Effect<void>;
  signal(signo: number): Effect.Effect<void>;
  getTcpPort(port: number): Effect.Effect<Fetcher>;
  setInactivityTimeout(durationMs: number | bigint): Effect.Effect<void>;
  interceptOutboundHttp(addr: string, binding: Fetcher): Effect.Effect<void>;
  interceptAllOutboundHttp(binding: Fetcher): Effect.Effect<void>;
};

/**
 * A Cloudflare Container that runs a long-lived process alongside a
 * Durable Object.
 *
 * Containers always use the **modular** pattern because the class runs
 * in the DO's bundle while the `.make()` runs inside the container
 * process — they are physically separate programs. See the
 * {@link https://alchemy.run/concepts/platform | Platform concept} page
 * for how this fits into the async / inline / modular progression.
 *
 * The class declares the container's typed shape — its RPC methods
 * and configuration — while `.make()` provides the runtime
 * implementation that actually runs inside the container process.
 * When a Durable Object imports the class to bind a container, the
 * bundler only pulls in the tiny class file; the `.make()` and all
 * its dependencies (process spawners, SDKs, etc.) are tree-shaken
 * out of the DO's bundle entirely.
 *
 * ```
 * src/Sandbox.ts          <- class + config, ~10 lines
 * src/Sandbox.runtime.ts  <- Sandbox.make() (default export)
 * ```
 *
 * The DO imports only `src/Sandbox.ts`. The container process
 * runs `src/Sandbox.runtime.ts`. The bundler never includes the
 * runtime file in the DO's output.
 *
 * @section Defining the Class
 * The class declares the container's identity, configuration, and
 * typed shape. The second type parameter is a record of method
 * names to Effect-returning functions — these become typed RPC
 * methods callable from the Durable Object that starts the
 * container.
 *
 * @example Container class
 * ```typescript
 * // src/Sandbox.ts
 * export class Sandbox extends Cloudflare.Container<
 *   Sandbox,
 *   {
 *     exec: (cmd: string) => Effect.Effect<{
 *       exitCode: number;
 *       stdout: string;
 *       stderr: string;
 *     }>;
 *   }
 * >()(
 *   "Sandbox",
 *   { main: import.meta.filename },
 * ) {}
 * ```
 *
 * @section Implementing the Runtime
 * `Container.make()` provides the runtime implementation. Use
 * `Container.of` to construct the typed shape — it ensures your
 * implementation matches the methods declared on the class. The
 * `.make()` call should be the default export of the container's
 * entrypoint file.
 *
 * @example Container runtime
 * ```typescript
 * // src/Sandbox.runtime.ts
 * export default Sandbox.make(
 *   Effect.gen(function* () {
 *     const cp = yield* ChildProcessSpawner;
 *
 *     return Sandbox.of({
 *       exec: (cmd) =>
 *         cp.spawn(ChildProcess.make(cmd, { shell: true })).pipe(
 *           Effect.map(({ exitCode, stdout, stderr }) => ({
 *             exitCode, stdout, stderr,
 *           })),
 *           Effect.scoped,
 *         ),
 *       fetch: Effect.succeed(
 *         HttpServerResponse.text("Hello from container!"),
 *       ),
 *     });
 *   }),
 * );
 * ```
 *
 * @section Configuration
 * The props object accepts `main` (entrypoint file), `instanceType`
 * (compute size), `runtime` (`"bun"` or `"node"`), and
 * `observability` settings. Use `Stack.useSync` to vary config by
 * stage.
 *
 * @example Stage-dependent configuration
 * ```typescript
 * export class Sandbox extends Cloudflare.Container<Sandbox>()(
 *   "Sandbox",
 *   Stack.useSync((stack) => ({
 *     main: import.meta.filename,
 *     instanceType: stack.stage === "prod" ? "standard-1" : "dev",
 *     observability: { logs: { enabled: true } },
 *   })),
 * ) {}
 * ```
 *
 * @section Starting from a Durable Object
 * Use `Cloudflare.Container.bind` in the outer init phase to bind
 * the container class, then `Cloudflare.start` in the inner
 * per-instance phase to start it. Because the DO only imports the
 * class, the runtime implementation is completely excluded from the
 * DO's bundle.
 *
 * @example Binding and starting a container
 * ```typescript
 * // init (outer Effect) — only imports the class
 * const sandbox = yield* Cloudflare.Container.bind(Sandbox);
 *
 * // per-instance (inner Effect)
 * return Effect.gen(function* () {
 *   const container = yield* Cloudflare.start(sandbox);
 *
 *   return {
 *     exec: (cmd: string) => container.exec(cmd),
 *   };
 * });
 * ```
 *
 * @section HTTP Requests to Container Ports
 * Use `getTcpPort` to get a `fetch` handle for a specific port on
 * the running container. This lets you make HTTP requests to
 * servers running inside the container process.
 *
 * @example Fetching from a container port
 * ```typescript
 * const container = yield* Cloudflare.start(sandbox);
 * const { fetch } = yield* container.getTcpPort(3000);
 *
 * const response = yield* fetch(
 *   HttpClientRequest.get("http://container/health"),
 * );
 * ```
 */
export const Container: Platform<
  ContainerApplication,
  ContainerServices,
  ContainerShape,
  Server.ProcessContext,
  Container
> & {
  bind: typeof bindContainer;
} = Platform(
  "Cloudflare.Container",
  {
    createExecutionContext: (id: string): Server.ProcessContext => {
      const runners: Effect.Effect<void, never, any>[] = [];
      const env: Record<string, any> = {};

      const serve = <Req = never>(handler: HttpEffect<Req>) =>
        Effect.sync(() => {
          runners.push(
            Effect.gen(function* () {
              const httpServer = yield* Effect.serviceOption(HttpServer).pipe(
                Effect.map(Option.getOrUndefined),
              );
              if (httpServer) {
                yield* httpServer.serve(handler);
                yield* Effect.never;
              } else {
                // this should only happen at plantime, validate?
              }
            }).pipe(Effect.orDie),
          );
        });

      return {
        Type: ContainerTypeId,
        LogicalId: id,
        id,
        env,
        set: (bindingId: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
            env[key] = output.pipe(
              Output.map((value) => JSON.stringify(value)),
            );
            return key;
          }),
        get: <T>(key: string) =>
          Config.string(key)
            .asEffect()
            .pipe(
              Effect.flatMap((value) =>
                Effect.try({
                  try: () => JSON.parse(value) as T,
                  catch: (error) => error as Error,
                }),
              ),
              Effect.catch((cause) =>
                Effect.die(
                  new Error(`Failed to get environment variable: ${key}`, {
                    cause,
                  }),
                ),
              ),
            ),
        run: ((effect: Effect.Effect<void, never, any>) =>
          Effect.sync(() => {
            runners.push(effect);
          })) as unknown as Server.ProcessContext["run"],
        serve,
        exports: Effect.sync(() => ({
          default: Effect.all(
            runners.map((eff) =>
              Effect.forever(
                eff.pipe(
                  // Log and ignore errors (daemon mode, it should just re-run)
                  Effect.tapError((err) => Effect.logError(err)),
                  Effect.ignore,
                  // TODO(sam): ignore cause? for now, let that actually kill the server
                  // Effect.ignoreCause
                ),
              ),
            ),
            {
              concurrency: "unbounded",
            },
          ),
        })),
      } as Server.ProcessContext;
    },
  },
  {
    bind: bindContainer,
  },
);
