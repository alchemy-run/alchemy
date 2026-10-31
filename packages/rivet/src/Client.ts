import * as Output from "alchemy/Output";
import type { PlatformIdentity } from "alchemy/Platform";
import { makeFetchRpcStub, reviveRpcStubErrors, type RpcErrorClass } from "alchemy/Rpc";
import type { RpcCallError } from "alchemy/Rpc";
import { RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { HttpServerError } from "effect/http/HttpServerError";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Cluster } from "./Cluster.ts";
import type { DurableObject } from "./DurableObject.ts";
import { fromNativeFetcher } from "./internal/Fetcher.ts";
import { gatewayFetcher } from "./internal/Gateway.ts";

/** A reference to a `Rivet.DurableObject` class. */
export type DurableObjectRef = Effect.Effect<DurableObject, never, any> & PlatformIdentity;

/** The RPC shape a Durable Object class's instances expose. */
export type ShapeOf<D> = D extends { readonly prototype: infer S }
  ? S
  : D extends abstract new (_: never) => infer S
    ? S
    : never;

/** One instance of a Durable Object: its RPC methods and its `fetch`. */
export type DurableObjectStub<Shape> = Shape & {
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError | RpcCallError,
    RuntimeContext
  >;
};

/** Every instance of one Durable Object class, addressed by name. */
export interface DurableObjectNamespace<Shape> {
  /** The actor name: the class's logical id. */
  readonly name: string;
  /** The instance called `name`, created on first use. */
  getByName(name: string): DurableObjectStub<Shape>;
}

export interface ClientOptions {
  /** Tagged failures to reconstruct on this side of RPC. */
  errors?: ReadonlyArray<RpcErrorClass>;
}

/** `Rivet.Client` was used outside a runtime's Effect, where nothing can carry its settings. */
export class ClientHasNoRuntime extends Data.TaggedError("Rivet.ClientHasNoRuntime")<{
  readonly message: string;
}> {}

/**
 * Call a `Rivet.DurableObject` from any runtime — a Cloudflare Worker, a
 * Lambda, a container, or another Durable Object. Requests go through the
 * control plane's gateway, which creates the instance in its pool on first
 * use, so the caller needs no RivetKit and no route to the nodes.
 *
 * The runtime gets the control plane's endpoint, namespace and token, and
 * the class's pool, as environment values. Provide the `Rivet.Cluster` the
 * Durable Object runs on.
 *
 * ### Calling a Durable Object
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Rivet.Client(Counter);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const count = yield* counters.getByName("visits").increment();
 *         return HttpServerResponse.text(String(count));
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cluster)),
 * ) {}
 * ```
 *
 * **Example:** Reconstruct typed failures
 * ```typescript
 * const counters = yield* Rivet.Client(Counter, { errors: [CounterBoom] });
 * ```
 *
 * @binding
 * @product Rivet
 */
export const Client = <D extends DurableObjectRef>(
  object: D,
  options: ClientOptions = {},
): Effect.Effect<DurableObjectNamespace<ShapeOf<D>>, never, Cluster | Effect.Services<D>> =>
  Effect.gen(function* () {
    const name = object.LogicalId;
    const cluster = yield* Cluster;
    const ctx = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeContext));
    if (ctx === undefined) {
      return yield* Effect.die(
        new ClientHasNoRuntime({
          message: `Rivet.Client(${name}) must be used inside a Worker, Function or other runtime.`,
        }),
      );
    }
    // While deploying, depend on the class for the pool that hosts it. The
    // class is built here, inside the caller's phase, on a memo map of its
    // own: reusing the caller's would hand it the caller's already-built pool
    // Layer, which then never registers the class.
    const pool = globalThis.__ALCHEMY_RUNTIME__
      ? undefined
      : (yield* object.pipe(Effect.provideServiceEffect(Layer.CurrentMemoMap, Layer.makeMemoMap)))
          .pool;
    // Bound as environment values while deploying; read back from them at
    // runtime.
    const bind = <T>(key: string, value: unknown) =>
      ctx
        .set(sanitizeKey(key), Output.isOutput(value) ? value : Output.literal(value))
        .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));

    const endpoint = yield* bind<string>(
      "RIVET_CLIENT_ENDPOINT",
      cluster.nodeEndpoint ?? cluster.endpoint,
    );
    const token = yield* bind<Redacted.Redacted<string> | string>(
      "RIVET_CLIENT_TOKEN",
      cluster.token,
    );
    const namespace = yield* bind<string>("RIVET_CLIENT_NAMESPACE", cluster.namespace);
    const poolName = yield* bind<string>(`RIVET_CLIENT_POOL_${name}`, pool);

    return {
      name,
      getByName: (key: string) => {
        const fetcher = fromNativeFetcher(
          gatewayFetcher({
            endpoint: endpoint ?? "",
            token:
              token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
            namespace: namespace ?? "",
            pool: poolName ?? "",
            name,
            key,
          }),
        );
        // RPC crosses the gateway as fetch-RPC over the actor's `fetch`.
        return reviveRpcStubErrors(
          makeFetchRpcStub<Record<string, unknown>>({
            fetch: (request: HttpClientRequest.HttpClientRequest) =>
              // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- erases RuntimeContext, which the caller's runtime provides at call time
              fetcher.fetch(request) as Effect.Effect<
                HttpClientResponse.HttpClientResponse,
                unknown
              >,
            base: {
              fetch: (request: HttpServerRequest.HttpServerRequest) => fetcher.fetch(request),
            },
          }),
          options.errors,
        ) as DurableObjectStub<ShapeOf<D>>;
      },
    } satisfies DurableObjectNamespace<ShapeOf<D>>;
  });
