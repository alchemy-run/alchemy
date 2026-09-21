import type { NodeServices } from "@effect/platform-node/NodeServices";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { Scope } from "effect/Scope";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpEffect } from "../../Http.ts";
import { HttpServer } from "../../Http.ts";
import {
  serveRpc,
  type RpcCallError,
  type RpcDecodeError,
  type RpcRemoteStreamError,
} from "../../Rpc.ts";
import type * as Stream from "effect/Stream";
import { effectClass } from "../../Util/effect.ts";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { ContainerClient } from "./Native.ts";

export type ContainerInstanceType =
  | "dev"
  | "lite"
  | "basic"
  | "standard"
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4";

export interface ContainerOptions {
  /** CPU and memory size; disk quotas are not enforced. @default "dev" */
  instanceType?: ContainerInstanceType;
  /** Approximate fleet-wide concurrent limit, not a strict admission guarantee. */
  maxInstances?: number;
  /** OCI runtime installed on the nodes, such as runsc. Not a language runtime. */
  ociRuntime?: string;
}

export interface ImageContainerProps extends ContainerOptions {
  /** Registry image to pull at deployment, or a Dockerfile path to build. */
  image: string;
}

export interface GeneratedContainerProps extends ContainerOptions {
  /** Language runtime used by the generated image. @default "bun" */
  runtime?: "bun" | "node";
}

export interface ContainerProgramProps extends GeneratedContainerProps {
  /** Module default-exporting Tool.make(...), separate from the declaration. */
  main: string;
}

/** Deploy-time input; never a separately provisioned cloud container. */
export type ContainerProps = ImageContainerProps | ContainerProgramProps;

export type ContainerDeclaration = ContainerProps & {
  /** Logical declaration name, used only to identify the binding. */
  name: string;
  /** Same-script SQLite Durable Object class that owns the actual container. */
  className: string;
};

/** Services supplied by the generated Bun/Node process bootstrap. */
export type ContainerRuntimeServices =
  | NodeServices
  | HttpClient
  | HttpServer
  | RuntimeContext
  | Scope;

/** Generated HTTP RPC is request-only and does not leak process services. */
export type ContainerRpcClient<Shape> = {
  [
    K in keyof Shape as Shape[K] extends (...args: never[]) => unknown
      ? K
      : never
  ]: Shape[K] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, infer E, infer _R>
    ? (
        ...args: Args
      ) => Effect.Effect<A, E | RpcCallError | RpcDecodeError, RuntimeContext>
    : Shape[K] extends (
          ...args: infer Args
        ) => Stream.Stream<infer A, infer E, infer _R>
      ? (
          ...args: Args
        ) => Stream.Stream<
          A,
          E | RpcCallError | RpcDecodeError | RpcRemoteStreamError,
          RuntimeContext
        >
      : never;
};

export type ContainerInstance<Shape extends object = {}> = ContainerClient &
  ContainerRpcClient<Shape>;

type ContainerProgramShape<Shape extends object> = Shape & {
  fetch?: HttpEffect<ContainerRuntimeServices>;
} & { [K in keyof ContainerClient]?: never };

export interface ContainerApplication<Self> {
  readonly "~celld/Container/Application": Self;
}

export interface ContainerClass<
  Self,
  Shape extends object = {},
  Req = never,
> extends Effect.Effect<ContainerInstance<Shape>, never, Self> {
  new (_: never): ContainerInstance<Shape>;
  readonly "~celld/Container/Id": string;
  readonly "~celld/Container/Tag": Context.Service<
    Self,
    ContainerInstance<Shape>
  >;
  readonly "~celld/Container/Source": Effect.Effect<ContainerProps, never, Req>;
  /** Register a generated program; provide this layer on the owning Stack. */
  make<E, R extends ContainerRuntimeServices>(
    props: ContainerProgramProps,
    impl: Effect.Effect<ContainerProgramShape<Shape>, E, R>,
  ): Layer.Layer<ContainerApplication<Self>> & {
    readonly "~celld/Container/Program": Effect.Effect<
      never,
      E,
      R | ContainerRuntimeServices
    >;
  };
  /** Check a generated program's shape without widening it. */
  of(impl: ContainerProgramShape<Shape>): ContainerProgramShape<Shape>;
}

/**
 * An image declaration attached to a Celld SQLite Durable Object, not a cloud
 * container resource. The host must use EC2 capacity with a Docker-compatible
 * engine and the privileged Celld fence image. Fargate cannot run containers.
 * The publishing Docker engine must support `image inspect --platform` and
 * `image save --platform`; archives contain only the fleet's CPU architecture.
 * Disks are ephemeral across destroy, node restart, and object migration.
 * Snapshots, hard timeouts, and outbound interception are not supported; the
 * default OCI runtime is not a VM isolation boundary.
 * Image/runtime changes require management quiescence: dropping an isolate does
 * not clear the native engine's cached per-cell container specification.
 *
 * ### Attaching an Image
 * **Example:** Declare an image and provide its runtime layer inside a DO
 * ```typescript
 * class Tool extends Celld.Container<Tool>()("Tool", {
 *   image: "alpine:3.20",
 *   instanceType: "dev",
 *   ociRuntime: "runsc",
 *   maxInstances: 4,
 * }) {}
 * const init = Effect.gen(function* () {
 *   const tool = yield* Tool;
 *   return Effect.succeed({ running: () => tool.running });
 * }).pipe(Effect.provide(Celld.Containers.layer(Tool)));
 * ```
 *
 * ### Generated Images
 * **Example:** Keep the declaration and implementation in separate modules
 * ```typescript
 * // tool.ts
 * export class Tool extends Celld.Container<Tool>()("Tool", {
 *   runtime: "bun", ociRuntime: "runsc",
 * }) {}
 * ```
 * ```typescript
 * // tool.runtime.ts
 * import { Tool } from "./tool.ts";
 * export default Tool.make({ main: import.meta.url }, Effect.succeed({
 *   fetch: Effect.succeed(HttpServerResponse.text("hello")),
 * }));
 * ```
 * Provide the default-exported make layer on the Stack. Import only the class
 * into the Durable Object. Generated programs listen on port 3000. Their init
 * effects run in the container process, not during Worker planning. Native
 * control method names (including exec) are reserved; use distinct names for
 * generated RPC methods. Supply application services on the implementation
 * itself; only platform services are installed by the process bootstrap.
 *
 * @resource
 * @product Celld
 */
export const Container = <Self, Shape extends object = {}>() => {
  function declare(
    id: string,
    props: ImageContainerProps,
  ): ContainerClass<Self, Shape>;
  function declare(
    id: string,
    props?: GeneratedContainerProps,
  ): ContainerClass<Self, Shape, ContainerApplication<Self>>;
  function declare(
    id: string,
    props: ImageContainerProps | GeneratedContainerProps = {},
  ): ContainerClass<Self, Shape, ContainerApplication<Self>> {
    const tag = Context.Service<Self, ContainerInstance<Shape>>(
      `Celld.Container<${id}>`,
    );
    const application = Context.Service<
      ContainerApplication<Self>,
      ContainerProgramProps
    >(`Celld.ContainerProgram<${id}>`);
    return Object.assign(effectClass<ContainerInstance<Shape>>()(tag), {
      "~celld/Container/Id": id,
      "~celld/Container/Tag": tag,
      "~celld/Container/Source":
        "image" in props ? Effect.succeed(props) : application,
      of: (shape: ContainerProgramShape<Shape>) => shape,
      make: <E, R extends ContainerRuntimeServices>(
        program: ContainerProgramProps,
        impl: Effect.Effect<ContainerProgramShape<Shape>, E, R>,
      ) => {
        if ("image" in props)
          throw new TypeError(
            "An image-backed Celld.Container cannot also declare a generated program",
          );
        const resolved = { ...props, ...program };
        return Object.assign(Layer.succeed(application, resolved), {
          "~celld/Container/Program": Effect.gen(function* () {
            const shape = yield* impl;
            const server = yield* HttpServer;
            const methods = yield* Effect.sync(() =>
              Object.fromEntries(Object.entries(shape)),
            );
            yield* server.serve(
              serveRpc(
                methods,
                shape.fetch ??
                  Effect.succeed(HttpServerResponse.empty({ status: 404 })),
              ),
              { port: 3000 },
            );
            return yield* Effect.never;
          }),
        });
      },
    });
  }
  return declare;
};
