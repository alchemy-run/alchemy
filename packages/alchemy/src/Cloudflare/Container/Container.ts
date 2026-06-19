import type * as cf from "@cloudflare/workers-types";
import type { Id } from "@distilled.cloud/aws/apigatewayv2";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HttpServer, type HttpEffect } from "../../Http.ts";
import type { InputProps } from "../../Input.ts";
import type { Named } from "../../Named.ts";
import * as Output from "../../Output.ts";
import { Platform } from "../../Platform.ts";
import type { Rpc } from "../../Rpc.ts";
import * as Server from "../../Server/index.ts";
import type { Fetcher } from "../Fetcher.ts";
import { fromCloudflareFetcher, toCloudflareFetcher } from "../Fetcher.ts";
import type { Providers } from "../Providers.ts";
import { DurableObjectNamespace } from "../Workers/DurableObjectNamespace.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { Worker } from "../Workers/Worker.ts";
import type {
  ContainerApplication,
  ContainerApplicationProps,
  ContainerServices,
  ContainerShape,
} from "./ContainerApplication.ts";
import { start } from "./StartContainer.ts";

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

export interface EffectfulContainerProps extends ContainerApplicationProps {
  main: string;
}
export interface ExternalContainerProps extends ContainerApplicationProps {
  /**
   * The directory containing the Dockerfile and other files for the container.
   *
   * @default `./`
   */
  context?: string;
  /**
   * The Dockerfile to use for the container.
   *
   * @default `./Dockerfile resolved relative to the {@link context} directory.
   */
  dockerfile?: string;
}
export interface RemoteContainerProps extends ContainerApplicationProps {
  /**
   * The image to use for the container.
   *
   * E.g. `ghcr.io/alpine/alpine:latest`
   */
  image: string;
}

export type Container<Id extends string = string> = {
  id: Id;
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

export declare namespace Container {
  export type Decl<Id extends string, Shape, Req = never> =
    | (ContainerApplication & Rpc<Shape> & Named<Id>)
    | (Effect.Effect<ContainerApplication & Rpc<Shape>, never, Req> &
        Named<Id>);
  export interface Bound<Shape>
    extends
      Container,
      Effect.Effect<Container.Running<Shape>, never, DurableObjectState> {
    "alchemy/Id": string;
  }

  export type Running<Shape = any> = Container &
    Shape & {
      getTcpPort: (portNumber: number) => Effect.Effect<{
        fetch: {
          (
            request: HttpClientRequest.HttpClientRequest,
          ): Effect.Effect<HttpClientResponse.HttpClientResponse>;
          (
            request: HttpServerRequest.HttpServerRequest,
          ): Effect.Effect<HttpServerResponse.HttpServerResponse>;
        };
      }>;
    };
}

/**
 * A Cloudflare Container that runs a long-lived process alongside a
 * Durable Object.
 *
 * Containers always use the **Container Layer** pattern — the class
 * and `.make()` must live in separate files. A Container must be
 * bound to a Durable Object, and the DO imports the class to get a
 * typed handle. If the class and `.make()` lived in the same file,
 * the DO's bundle would pull in all of the container's runtime
 * dependencies (process spawners, Node APIs, SDKs, etc.), which
 * would bloat the bundle and likely break the Cloudflare Workers
 * runtime. Keeping them separate ensures the bundler only includes
 * the tiny class in the DO's output.
 *
 * See the {@link https://alchemy.run/concepts/platform | Platform
 * concept} page for how this fits into the async / effect / layer
 * progression.
 * @resource
 * @product Containers
 * @category Workers & Compute
 * @section Container Layer
 * Define the class and `.make()` in separate files. The class
 * declares the container's identity, configuration, and typed
 * shape. `.make()` provides the runtime implementation as a
 * default export. Use `Container.of` to construct the typed
 * shape — it ensures your implementation matches the methods
 * declared on the class.
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
 * @example Container .make()
 * ```typescript
 * // src/Sandbox.runtime.ts
 * export default Sandbox.make(
 *   Effect.gen(function* () {
 *     const cp = yield* ChildProcessSpawner;
 *
 *     return Sandbox.of({
 *       exec: (command) =>
 *         cp.spawn(ChildProcess.make(command, { shell: true })).pipe(
 *           Effect.flatMap(({ exitCode, stdout, stderr }) =>
 *             Effect.all({
 *               exitCode,
 *               stdout: stdout.pipe(Stream.decodeText, Stream.mkString),
 *               stderr: stderr.pipe(Stream.decodeText, Stream.mkString),
 *             }),
 *           ),
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
 * `observability` settings. Use `Stack.useSync` to read the
 * surrounding stack at declaration time and pick a beefier
 * `instanceType` in prod while keeping the cheap `dev` instance for
 * preview environments.
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
 * @section Stack-level wiring
 * The `.make()` `export default` is the side-effect that registers
 * the container's runtime. It must be reachable from your
 * `alchemy.run.ts` so the bundler emits the runtime entrypoint.
 * Provide it on the Stack's generator with `Effect.provide`.
 *
 * @example Wiring SandboxLive into the Stack
 * ```typescript
 * // alchemy.run.ts
 * import SandboxLive from "./src/Sandbox.runtime.ts";
 *
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Cloudflare.providers(), state: Cloudflare.state() },
 *   Effect.gen(function* () {
 *     const worker = yield* Worker;
 *     return { url: worker.url };
 *   }).pipe(Effect.provide(SandboxLive)),
 * );
 * ```
 *
 * @section Calling from a Durable Object
 * Use `Cloudflare.Container.bind(Sandbox)` in the **outer** init
 * phase of a Durable Object — only the class is imported, so the
 * DO bundle stays tiny. Then `Cloudflare.start(sandbox)` in the
 * **inner** per-instance phase ensures the container is running
 * and gives you a typed handle that exposes every method declared
 * on the container's shape **plus** a `getTcpPort` helper.
 *
 * @example Binding and starting a container from a DO
 * ```typescript
 * export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
 *   "Agents",
 *   Effect.gen(function* () {
 *     // OUTER (init): only the class is referenced — the runtime
 *     // implementation in `Sandbox.runtime.ts` is tree-shaken out
 *     // of this DO's bundle.
 *     const sandbox = yield* Cloudflare.Container.bind(Sandbox);
 *
 *     return Effect.gen(function* () {
 *       // INNER (per-instance): start the container and expose RPC.
 *       const container = yield* Cloudflare.start(sandbox, { enableInternet: true });
 *
 *       return {
 *         exec: (cmd: string) => container.exec(cmd),
 *       };
 *     });
 *   }),
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
 *   const container = yield* Cloudflare.start(sandbox, { enableInternet: true });
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
 * const container = yield* Cloudflare.start(sandbox, { enableInternet: true });
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
  (
    id: string,
    props: InputProps<
      EffectfulContainerProps | ExternalContainerProps | RemoteContainerProps
    >,
  ): Effect.Effect<Container, never, Providers> & {
    new (): {};
  };
  /**
   * Bind a Container to a Durable Object Namespace (during plan construction time).
   */
  bind: <Id extends string, Shape, Req = never>(
    containerEff: Container.Decl<Id, Shape, Req>,
  ) => Effect.Effect<Container.Bound<Shape>, never, Req>;
  /**
   * Take a dependency on a running Container within a Durable Object context.
   */
  running: <Shape, Req = never>(
    containerEff: Container.Decl<Id, Shape, Req>,
  ) => Container.Bound<Shape>;
  /**
   * Provide a Layer that starts a Container and makes it available to the Durable Object.
   */
  layer: <Shape>(
    containerEff: Container.Bound<Shape>,
    options?: ContainerStartupOptions,
  ) => Layer.Layer<Container.Running<Shape>, never, DurableObjectState>;
} = Platform(
  "Cloudflare.Container",
  {
    createRuntimeContext: (id: string): Server.ProcessContext => {
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
    bind: Effect.fnUntraced(function* <Shape, Req = never>(
      containerEff:
        | (ContainerApplication & Rpc<Shape>)
        | Effect.Effect<ContainerApplication & Rpc<Shape>, never, Req>,
    ) {
      const namespace = yield* DurableObjectNamespace;

      const container = Effect.isEffect(containerEff)
        ? yield* containerEff as unknown as Effect.Effect<
            ContainerApplication & Rpc<Shape>
          >
        : containerEff;

      yield* container.bind`${namespace}`({
        durableObjects: {
          namespaceId: namespace.namespaceId,
        },
      });

      const worker = yield* Worker;
      const className = namespace.name;

      yield* worker.bind`${container.LogicalId}`({
        containers: [{ className, dev: container.dev }],
      });

      // TODO(sam): register this in the Container Execution Context
      // const _httpEffect = yield* init;
      return Effect.gen(function* () {
        const state = yield* DurableObjectState;
        return {
          id: container.LogicalId,
          running: Effect.sync(() => state.container!.running ?? false),
          destroy: (error?: any) =>
            Effect.promise(() => state.container!.destroy(error)),
          signal: (signo: number) =>
            Effect.sync(() => state.container!.signal(signo)),
          getTcpPort: (port: number) =>
            Effect.sync(() =>
              fromCloudflareFetcher(state.container!.getTcpPort(port)),
            ),
          setInactivityTimeout: (durationMs: number | bigint) =>
            Effect.sync(() =>
              state.container!.setInactivityTimeout(durationMs),
            ),
          interceptOutboundHttp: (addr: string, binding: Fetcher) =>
            toCloudflareFetcher(binding).pipe(
              Effect.map((binding) =>
                state.container!.interceptOutboundHttp(addr, binding),
              ),
            ),
          interceptAllOutboundHttp: (binding: Fetcher) =>
            toCloudflareFetcher(binding).pipe(
              Effect.map((binding) =>
                state.container!.interceptAllOutboundHttp(binding),
              ),
            ),
          monitor: () =>
            Effect.promise(
              () => state.container?.monitor() ?? Promise.resolve(),
            ),
          start: (options?: ContainerStartupOptions) =>
            Effect.sync(() => state.container!.start(options)),
        } as unknown;
      });
    }),
    running: (containerEff: Container.Decl<any, any>) =>
      Context.Service()(`Container.Running<${containerEff["alchemy/Id"]}>`),
    layer: <Image extends Container>(
      containerEff: Container.Bound<Image>,
      options?: ContainerStartupOptions,
    ) =>
      Layer.effect(
        Context.Service()(`Container.Running<${containerEff["alchemy/Id"]}>`),
        start(containerEff, options),
      ),
  },
);
