/// <reference types="@cloudflare/workers-types" />

import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { taggedFunction } from "alchemy/Util/effect";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Worker } from "../Workers/Worker.ts";
import type { DispatchNamespace as DispatchNamespaceResource } from "./DispatchNamespace.ts";

/** The `~alchemy/Kind` brand on a {@link DispatchBinding}. */
export const DispatchBindingKind = "Cloudflare.WorkersForPlatforms.Get" as const;

/** A dispatch namespace, or the declaration that yields one. */
export type DispatchNamespaceInput =
  | DispatchNamespaceResource
  | Effect.Effect<DispatchNamespaceResource, never, any>;

/**
 * The Worker an outbound binding sends user Workers' `fetch()` calls to: a
 * `Cloudflare.Worker` in this stack, or a `Cloudflare.Worker.ref(...)` to one
 * another stack deploys. Cloudflare calls its default export: an upload that
 * names an entrypoint is accepted, but the entrypoint isn't kept, so a
 * `Cloudflare.WorkerEntrypoint` target is refused. Route inside the default
 * export instead.
 */
export type OutboundWorker = Worker | Effect.Effect<Worker, never, any>;

/**
 * The outbound Worker of a dispatch binding and the names of the values the
 * dispatcher passes it, as a {@link DispatchBinding} carries them.
 */
export interface DispatchOutbound {
  readonly worker: OutboundWorker;
  readonly parameters: ReadonlyArray<string>;
}

/** Options of a {@link Get} dispatch binding. */
export type GetOptions<P extends object = {}> = {
  /**
   * The Worker that receives every `fetch()` a dispatched user Worker makes,
   * in place of the internet: a `Cloudflare.Worker`, or a
   * `Cloudflare.Worker.ref(...)` to one another stack deploys.
   */
  readonly outbound?: OutboundWorker;
} & ([keyof P] extends [never]
  ? {
      /** No values: the params type declares none. */
      readonly parameters?: readonly [];
    }
  : {
      /**
       * The names of the values the dispatcher passes the outbound Worker on
       * each dispatch, as `get(name, args, { outbound: { … } })`. Each
       * arrives on the outbound Worker as `env.<name>`. List every key of the
       * params type: Cloudflare forwards only the names declared here, and
       * the value of a key left out never arrives.
       */
      readonly parameters: ReadonlyArray<keyof P & string>;
    });

/** {@link Get}'s options: required, with `outbound`, once `P` declares a value. */
type GetArgs<P extends object> = [keyof P] extends [never]
  ? [options?: GetOptions<P>]
  : [options: GetOptions<P> & { readonly outbound: OutboundWorker }];

/** The outbound Worker and parameter names of {@link Get}'s options, if any. */
export const dispatchOutboundOf = (
  options: GetOptions<any> | undefined,
): DispatchOutbound | undefined =>
  options?.outbound === undefined
    ? undefined
    : { worker: options.outbound, parameters: options.parameters ?? [] };

/**
 * The values of one dispatch: one per declared parameter, each a JSON value.
 * Cloudflare requires every declared parameter on each dispatch: `get()`
 * throws `Missing one or more required arguments to worker` when one is left
 * out, and an `undefined` value fails the request. So an optional key of the
 * params type is required here, and `null` stands for "no value".
 */
export type OutboundValues<P extends object> = {
  readonly [K in keyof P]-?: Exclude<P[K], undefined>;
};

/**
 * The options of one dispatch. On a binding with an outbound Worker and a
 * params type, `outbound` is required and typed by {@link OutboundValues}.
 */
export type DispatchOptions<P extends object = {}> = [keyof P] extends [never]
  ? DynamicDispatchOptions
  : Omit<DynamicDispatchOptions, "outbound"> & {
      /** The values for the outbound Worker, which reads each as `env.<name>`. */
      readonly outbound: OutboundValues<P>;
    };

type DispatchArgs<P extends object> = [keyof P] extends [never]
  ? [options?: DynamicDispatchOptions]
  : [options: DispatchOptions<P>];

/**
 * The runtime binding of a {@link Get} with a params type, on an async
 * Worker's `env`: Cloudflare's `DispatchNamespace`, whose `get` requires the
 * declared outbound values.
 */
export interface OutboundDispatchNamespace<P extends object> {
  /**
   * @param name Name of the user Worker script.
   * @param args Arguments to the user Worker script (`props`).
   * @param options Limits for the invocation, and the outbound values.
   * @returns A `Fetcher` for the user Worker.
   * @throws If the script does not exist in the dispatch namespace.
   */
  get(name: string, args?: { [key: string]: any }, ...options: DispatchArgs<P>): Fetcher;
}

/** The runtime type of a dispatch binding with params type `P`. */
export type DispatchNamespaceFor<P extends object> = [keyof P] extends [never]
  ? DispatchNamespace
  : OutboundDispatchNamespace<P>;

/**
 * A dispatch binding, as {@link Get} returns it: an Effect that binds the
 * namespace to an Effect-native Worker and yields the
 * {@link DispatchNamespaceClient}, and an entry an async Worker's `env`
 * accepts, which `Cloudflare.InferEnv` types as the runtime binding.
 */
export interface DispatchBinding<P extends object = {}> extends Effect.Effect<
  DispatchNamespaceClient<P>,
  never,
  Get
> {
  readonly "~alchemy/Kind": typeof DispatchBindingKind;
  /** The bound namespace. */
  readonly namespace: DispatchNamespaceInput;
  /** The outbound Worker and the names of its values, if any. */
  readonly outbound: DispatchOutbound | undefined;
  /** @internal phantom */
  readonly "~params"?: P;
}

/**
 * Any {@link DispatchBinding}, as an async Worker's `env` accepts one. It
 * carries no params type: with `DispatchBinding<any>` here, a {@link Get}
 * written inline in an `env` infers its params type as `any` from this one.
 */
export type AnyDispatchBinding = Pick<DispatchBinding, "~alchemy/Kind" | "namespace" | "outbound">;

/** What {@link GetBinding} implements: bind the namespace, return the client. */
type GetShape = (
  namespace: DispatchNamespaceResource,
  options?: GetOptions<any>,
) => Effect.Effect<DispatchNamespaceClient<any>>;

/**
 * Bind a {@link DispatchNamespace} to a Worker and obtain the Effect-native
 * dynamic-dispatch client (`get`).
 *
 * `Get` is a single identifier that is simultaneously the binding's Context
 * tag, its type, and the callable (it declares its own typed call signature
 * instead of `Binding.Service`'s, which would accept any options) —
 * `yield* Cloudflare.WorkersForPlatforms.Get(namespace)`. The value it returns
 * also works as an entry on an async Worker's `env`.
 *
 * Provide {@link GetBinding} on the Worker's runtime layer to resolve the
 * underlying `dispatch_namespace` binding at request time.
 *
 *
 * ### Dispatching to user Workers
 * **Example:** Dispatch a request to a customer Worker
 * Bind the namespace during the Worker's init phase, then look up and forward
 * to a user Worker from a request handler.
 * ```typescript
 * const dispatch = yield* Cloudflare.WorkersForPlatforms.Get(namespace);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *     const userWorker = yield* dispatch.get("customer-a");
 *     return yield* Effect.promise(() => userWorker.fetch(request));
 *   }),
 * };
 * ```
 *
 * ### Routing user Workers' requests through an outbound Worker
 * **Example:** Declare an outbound Worker with typed parameters
 * Every `fetch()` a dispatched user Worker makes goes to the outbound Worker
 * instead of the internet. The params type names the values the dispatcher
 * passes on each dispatch, and `parameters` lists them, as Cloudflare
 * forwards only declared names. Each dispatch must pass every declared value
 * (`null` for none): Cloudflare refuses a dispatch that leaves one out.
 * ```typescript
 * type RequestContext = { tenant: string; requestId: string };
 *
 * const Egress = Cloudflare.Worker("Egress", { main: "./src/egress.ts" });
 *
 * export const Dispatch = Cloudflare.WorkersForPlatforms.Get<{
 *   requestContext: RequestContext;
 * }>(Namespace, {
 *   outbound: Egress,
 *   parameters: ["requestContext"],
 * });
 * ```
 *
 * **Example:** Bind it on an async Worker's env
 * The same value is an `env` entry. `InferEnv` types its `get`, so a missing
 * or mistyped outbound value is a compile error.
 * ```typescript
 * export const Dispatcher = Cloudflare.Worker("Dispatcher", {
 *   main: "./src/dispatcher.ts",
 *   env: { NS: Dispatch },
 * });
 * export type DispatcherEnv = Cloudflare.InferEnv<typeof Dispatcher>;
 *
 * // src/dispatcher.ts
 * const userWorker = env.NS.get(script, {}, {
 *   outbound: { requestContext: { tenant: script, requestId: crypto.randomUUID() } },
 * });
 * ```
 *
 * **Example:** Yield it in an Effect-native Worker
 * ```typescript
 * const dispatch = yield* Dispatch;
 * const userWorker = yield* dispatch.get(script, {}, {
 *   outbound: { requestContext: { tenant: script, requestId } },
 * });
 * ```
 *
 * **Example:** Read the values in the outbound Worker
 * The outbound Worker reads each value on its `env`.
 * ```typescript
 * // src/egress.ts
 * interface EgressEnv { requestContext: RequestContext }
 * export default {
 *   fetch(request: Request, env: EgressEnv) {
 *     console.log(env.requestContext.tenant);
 *     return fetch(request);
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/dynamic-dispatch/
 * @see https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
 *
 * @binding
 * @product Workers for Platforms
 * @category Workers & Compute
 */
export interface Get extends Context.Service<Get, GetShape>, Binding.ServiceLike {
  readonly key: "Cloudflare.WorkersForPlatforms.Get";
  /**
   * @param namespace The dispatch namespace to bind.
   * @param options An outbound Worker for the dispatched user Workers, and
   *   the names of the values it receives.
   */
  <P extends object = {}>(
    namespace: DispatchNamespaceInput,
    ...options: GetArgs<P>
  ): DispatchBinding<P>;
}

const GetService = Binding.Service<Get>("Cloudflare.WorkersForPlatforms.Get");

const bindGet = GetService as unknown as (
  namespace: DispatchNamespaceInput,
  options: GetOptions<any> | undefined,
) => Effect.Effect<DispatchNamespaceClient<any>, never, Get>;

export const Get: Get = taggedFunction(
  GetService as never,
  (namespace: DispatchNamespaceInput, options?: GetOptions<any>) =>
    // The `env` form reads the namespace and outbound off the value; the
    // Effect form runs it, which hands both to `GetBinding`.
    Object.assign(bindGet(namespace, options), {
      "~alchemy/Kind": DispatchBindingKind,
      namespace,
      outbound: dispatchOutboundOf(options),
    }),
) as unknown as Get;

/** Structural guard for a {@link DispatchBinding} on an async Worker's `env`. */
export const isDispatchBinding = (value: unknown): value is DispatchBinding<any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as { "~alchemy/Kind"?: unknown })["~alchemy/Kind"] === DispatchBindingKind;

/** Error raised by dynamic-dispatch runtime operations. */
export class DispatchNamespaceError extends Data.TaggedError("DispatchNamespaceError")<{
  /** Human-readable runtime error message. */
  message: string;
  /** Original error thrown by the Cloudflare runtime binding. */
  cause: unknown;
}> {}

/**
 * Effect-native client for a Workers for Platforms dispatch-namespace Worker
 * binding.
 *
 * Wraps the runtime `DispatchNamespace` binding so the lookup returns an
 * Effect tagged with {@link DispatchNamespaceError}. Use
 * `Cloudflare.WorkersForPlatforms.Get(namespace)` inside a Worker's init
 * phase.
 */
export interface DispatchNamespaceClient<P extends object = {}> {
  /** Effect resolving to the raw dispatch-namespace runtime binding. */
  raw: Effect.Effect<DispatchNamespace, never, RuntimeContext>;
  /**
   * Look up a user Worker in the dispatch namespace by script name and obtain
   * a `Fetcher` to send it requests.
   *
   * @param name Name of the user Worker script.
   * @param args Arguments passed to the user Worker script.
   * @param options Options for the dynamic-dispatch invocation. On a binding
   *   with an outbound Worker and a params type, `outbound` is required.
   */
  get(
    name: string,
    args?: { [key: string]: any },
    ...options: DispatchArgs<P>
  ): Effect.Effect<Fetcher, DispatchNamespaceError, RuntimeContext>;
}
