import type * as cf from "@cloudflare/workers-types";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { InputProps } from "../../Input.ts";
import type { Named } from "../../Named.ts";
import type { ResourceClassLike } from "../../Resource.ts";
import type { Rpc } from "../../Rpc.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Props } from "../../State/ResourceState.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Fetcher } from "../Fetcher.ts";
import type { Providers } from "../Providers.ts";
import { type WorkerShape } from "../Workers/Worker.ts";
import type {
  ContainerApplication,
  ContainerApplicationProps,
} from "./ContainerApplication.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";

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

/**
 * Bundle an Effect-native program into a generated image. Alchemy bundles
 * {@link main} and bakes it in as the container's entrypoint.
 */
export interface EffectfulContainerProps extends ContainerApplicationProps {
  /** Entrypoint file for the Effect program, typically `import.meta.filename`. */
  main: string;
}
/**
 * Build the container image from your own Dockerfile and build context — no
 * Effect program is bundled. The image is shipped as-is.
 */
export interface ExternalContainerProps extends ContainerApplicationProps {
  /**
   * The build context directory containing the Dockerfile and any files it
   * copies.
   *
   * @default `./`
   */
  context?: string;
  /**
   * The Dockerfile to build, resolved relative to {@link context}.
   *
   * @default `<context>/Dockerfile`
   */
  dockerfile?: string;
}
/**
 * Deploy a pre-built remote image — Alchemy pulls it and re-pushes it to
 * Cloudflare's managed registry without building anything.
 */
export interface RemoteContainerProps extends ContainerApplicationProps {
  /**
   * The pre-built image to pull and re-push.
   *
   * E.g. `ghcr.io/alpine/alpine:latest`
   */
  image: string;
}

export type Container<Id extends string = string> = Named<Id> & {
  get running(): Effect.Effect<boolean, never, RuntimeContext>;
  start(
    options?: ContainerStartupOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  monitor(): Effect.Effect<void, ContainerError, RuntimeContext>;
  destroy(error?: any): Effect.Effect<void, never, RuntimeContext>;
  signal(signo: number): Effect.Effect<void, never, RuntimeContext>;
  getTcpPort(port: number): Effect.Effect<Fetcher, never, RuntimeContext>;
  setInactivityTimeout(
    durationMs: number | bigint,
  ): Effect.Effect<void, never, RuntimeContext>;
  interceptOutboundHttp(
    addr: string,
    binding: Fetcher,
  ): Effect.Effect<void, never, RuntimeContext>;
  interceptAllOutboundHttp(
    binding: Fetcher,
  ): Effect.Effect<void, never, RuntimeContext>;
};

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
 * @section Image Sources
 * A container's image comes from one of three sources, picked by which
 * prop you set:
 *
 * - `main` — bundle your Effect program into a generated image.
 * - `context` (+ optional `dockerfile`) — build your own Dockerfile.
 * - `image` — pull a pre-built remote image and re-push it.
 *
 * Only the `main` source bundles and injects an Effect runtime. The other
 * two ship an arbitrary image as-is, so `.make()` just registers the
 * container's identity (it has no Effect implementation to run).
 *
 * @example Effect-native image (`main`)
 * ```typescript
 * // Alchemy bundles this file's Effect program and bakes it into a
 * // generated image as the entrypoint.
 * export class Sandbox extends Cloudflare.Container<
 *   Sandbox,
 *   { ping: () => Effect.Effect<string> }
 * >()("Sandbox", { main: import.meta.filename }) {}
 *
 * export default Sandbox.make(
 *   Effect.gen(function* () {
 *     return Sandbox.of({
 *       ping: () => Effect.succeed("pong"),
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     });
 *   }),
 * );
 * ```
 *
 * @example Build your own Dockerfile (`context` / `dockerfile`)
 * ```typescript
 * // Alchemy builds the Dockerfile against the context directory — no
 * // Effect bundling. `dockerfile` defaults to `<context>/Dockerfile`.
 * export class Web extends Cloudflare.Container<Web>()("Web", {
 *   context: `${import.meta.dirname}/context`,
 * }) {}
 *
 * // No Effect runtime to provide — `.make()` only registers identity.
 * export default Web.make(Effect.succeed(undefined));
 * ```
 *
 * @example Remote image (`image`)
 * ```typescript
 * // Alchemy pulls the public image and re-pushes it to Cloudflare's
 * // registry — no build, no bundling.
 * export class Echo extends Cloudflare.Container<Echo>()("Echo", {
 *   image: "mendhak/http-https-echo:latest",
 * }) {}
 *
 * export default Echo.make(Effect.succeed(undefined));
 * ```
 *
 * @example Reaching an arbitrary image's port from a Durable Object
 * ```typescript
 * // `external` and `remote` images expose no RPC methods, so the DO
 * // talks to them purely over their TCP port via `getTcpPort`.
 * export class WebObject extends Cloudflare.DurableObjectNamespace<WebObject>()(
 *   "WebObject",
 *   Effect.gen(function* () {
 *     const bound = yield* Cloudflare.Container.bind(Web);
 *     return Effect.gen(function* () {
 *       const container = yield* Cloudflare.start(bound);
 *       return {
 *         hello: () =>
 *           Effect.gen(function* () {
 *             const { fetch } = yield* container.getTcpPort(8080);
 *             const res = yield* fetch(HttpClientRequest.get("http://container/"));
 *             return yield* res.text;
 *           }),
 *       };
 *     });
 *   }),
 * ) {}
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
export const Container: ResourceClassLike<ContainerApplication> & {
  <const Id extends string>(
    id: Id,
    props: InputProps<ExternalContainerProps | RemoteContainerProps>,
  ): Container.Decl<Container<Id>, {}, Id>;
  <Self>(): {
    <
      const Id extends string,
      Props extends InputProps<ExternalContainerProps | RemoteContainerProps>,
    >(
      id: Id,
      props: Props,
    ): Container.Decl<Self, {}, Id>;
  };
  <Self, Shape>(): {
    <const Id extends string>(
      id: Id,
    ): Container.Decl<Self, Shape, Id, Container.Application<Self>>;
  };
} = ((...args: any[]) => {
  if (args.length === 0) {
    return (...args: any[]) => {
      if (args.length === 1) {
        const [id] = args as [string];
        const tag = ContainerPlatform()(id);
        // for containers, we want the `yield* ContainerTag` to act as the Binding
        const eff = ContainerPlatform.bind(tag);
        return Object.assign(effectClass(eff), {
          "~alchemy/Id": id,
          make: (props: any, impl: any) => tag.make(props, impl),
          // yield* MyContainer.Application to get the ContainerApplication Resource Outputs
          Application: tag,
        });
      } else {
        return Container(...(args as [string, any]));
      }
    };
  } else {
    const [id, props] = args as [string, any];
    const resource = ContainerPlatform(id, props);
    // for containers, we want the `yield* ContainerTag` to act as the Binding
    const eff = effectClass(ContainerPlatform.bind(resource));
    return Object.assign(eff, {
      "~alchemy/Id": id,
      // yield* MyContainer.Application to get the ContainerApplication Resource Outputs
      Application: resource,
    });
  }
}) as any;

export declare namespace Container {
  export interface Decl<
    Self = any,
    Shape = any,
    Id extends string = string,
    Req = never,
  >
    extends Effect.Effect<Self, never, Providers | Req>, Rpc<Shape>, Named<Id> {
    new (): Container<Id> & Shape;
    make: <InitReq = never, WorkerReq = never>(
      props: Props,
      impl: Effect.Effect<
        Shape & WorkerShape<WorkerReq>,
        Config.ConfigError,
        InitReq
      >,
    ) => Layer.Layer<Application<Self>, never, Providers>;
    of(shape: Shape & WorkerShape): Shape;
  }
  export namespace Decl {
    export type Any = Decl<any, any, string, any>;
  }

  export interface Application<Self> {
    "~alchemy/Kind": "ContainerApplication";
    "~alchemy/Self": Self;
  }

  export type Instance<Shape = any> = Container &
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
