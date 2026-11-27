/// <reference types="@cloudflare/workers-types" />

import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { taggedFunction } from "alchemy/Util/effect";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { Worker } from "../Workers/Worker.ts";
import type { DispatchNamespace as DispatchNamespaceResource } from "./DispatchNamespace.ts";

/** A dispatch binding's outbound Worker, or the declaration that yields it. */
export type OutboundWorker = Worker | Effect.Effect<Worker, never, any>;

/**
 * Options of a {@link Get} dispatch binding. `P` is the type of the values
 * each dispatch passes the outbound Worker.
 */
export type GetOptions<P extends object = {}> = {
  /**
   * The Worker that receives every `fetch()` a dispatched user Worker makes,
   * in place of the internet: a `Cloudflare.Worker`, or a
   * `Cloudflare.Worker.ref(...)` to one another stack deploys. Cloudflare
   * calls its default export.
   */
  readonly outbound?: OutboundWorker;
} & ([keyof P] extends [never]
  ? {
      /**
       * The names of the values the dispatcher passes the outbound Worker on
       * each dispatch, as `get(name, args, { outbound: { … } })`. Each
       * arrives on the outbound Worker as `env.<name>`.
       */
      readonly parameters?: ReadonlyArray<string>;
    }
  : {
      /**
       * The names of the values the dispatcher passes the outbound Worker on
       * each dispatch: the keys of `P`. Each arrives on the outbound Worker
       * as `env.<name>`.
       */
      readonly parameters: ReadonlyArray<keyof P & string>;
    });

/** {@link Get}'s options: required, with `outbound`, once `P` declares a value. */
type GetArgs<P extends object> = [keyof P] extends [never]
  ? [options?: GetOptions]
  : [options: GetOptions<P> & { readonly outbound: OutboundWorker }];

/**
 * The options of one dispatch. Cloudflare requires every declared value on
 * each dispatch: `get()` throws `Missing one or more required arguments to
 * worker` when one is left out, and an `undefined` value fails the request.
 * So every key of `P` is required here, and `null` stands for "no value".
 */
type DispatchArgs<P extends object> = [keyof P] extends [never]
  ? [options?: DynamicDispatchOptions]
  : [
      options: Omit<DynamicDispatchOptions, "outbound"> & {
        /** The values for the outbound Worker, which reads each as `env.<name>`. */
        readonly outbound: { readonly [K in keyof P]-?: Exclude<P[K], undefined> };
      },
    ];

/**
 * The runtime binding of a {@link Get} on an async Worker's `env`:
 * Cloudflare's `DispatchNamespace`, whose `get` requires the values `P`
 * declares.
 */
export type DispatchNamespaceFor<P extends object> = [keyof P] extends [never]
  ? DispatchNamespace
  : {
      /**
       * @param name Name of the user Worker script.
       * @param args Arguments to the user Worker script.
       * @param options Limits for the invocation, and the outbound values.
       */
      get(name: string, args?: { [key: string]: any }, ...options: DispatchArgs<P>): Fetcher;
    };

/**
 * A dispatch binding, as {@link Get} returns it: an Effect that binds the
 * namespace to an Effect-native Worker and yields the
 * {@link DispatchNamespaceClient}, and an entry an async Worker's `env`
 * accepts.
 */
export interface DispatchBinding<P extends object = {}> extends Effect.Effect<
  DispatchNamespaceClient<P>,
  never,
  Get
> {
  readonly "~alchemy/Kind": "Cloudflare.WorkersForPlatforms.Get";
  /** The bound namespace, or the declaration that yields it. */
  readonly namespace:
    | DispatchNamespaceResource
    | Effect.Effect<DispatchNamespaceResource, never, any>;
  readonly options: GetOptions<any> | undefined;
  /** @internal phantom */
  readonly "~params"?: P;
}

/**
 * Any {@link DispatchBinding}, as an async Worker's `env` accepts one. It
 * carries no `P`: with `DispatchBinding<any>` here, a {@link Get} written
 * inline in an `env` would infer its `P` as `any` from this one.
 */
export type AnyDispatchBinding = Pick<DispatchBinding, "~alchemy/Kind" | "namespace" | "options">;

/**
 * Bind a {@link DispatchNamespace} to a Worker and obtain the Effect-native
 * dynamic-dispatch client (`get`).
 *
 * `Get` is a single identifier that is simultaneously the binding's Context
 * tag, its type, and the callable —
 * `yield* Cloudflare.WorkersForPlatforms.Get(namespace)`. The value it returns
 * is also an entry on an async Worker's `env`.
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
 * **Example:** Declare an outbound Worker and its values
 * Every `fetch()` a dispatched user Worker makes goes to the outbound Worker
 * instead of the internet. The type parameter declares the values each
 * dispatch passes it, and `parameters` lists their names. Every dispatch must
 * pass every value (`null` for none): Cloudflare refuses one that leaves a
 * value out. In `alchemy dev` the binding has no outbound Worker, because
 * Cloudflare's preview refuses one: dispatches work, and user Workers reach
 * the internet directly.
 * ```typescript
 * const Egress = Cloudflare.Worker("Egress", { main: "./src/egress.ts" });
 *
 * export const Dispatch = Cloudflare.WorkersForPlatforms.Get<{ tenant: string }>(Namespace, {
 *   outbound: Egress,
 *   parameters: ["tenant"],
 * });
 * ```
 *
 * **Example:** Dispatch from an async Worker
 * `InferEnv` types `get`, so a missing or mistyped value is a compile error.
 * ```typescript
 * export const Dispatcher = Cloudflare.Worker("Dispatcher", {
 *   main: "./src/dispatcher.ts",
 *   env: { NS: Dispatch },
 * });
 * export type DispatcherEnv = Cloudflare.InferEnv<typeof Dispatcher>;
 *
 * // src/dispatcher.ts
 * const userWorker = env.NS.get(script, {}, { outbound: { tenant: script } });
 * ```
 *
 * **Example:** Dispatch from an Effect-native Worker
 * ```typescript
 * const dispatch = yield* Dispatch;
 * const userWorker = yield* dispatch.get(script, {}, { outbound: { tenant: script } });
 * ```
 *
 * **Example:** Read the values in the outbound Worker
 * ```typescript
 * // src/egress.ts
 * export default {
 *   fetch(request: Request, env: { tenant: string }) {
 *     console.log(env.tenant);
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
export interface Get
  extends
    Context.Service<
      Get,
      (
        namespace: DispatchNamespaceResource,
        options?: GetOptions<any>,
      ) => Effect.Effect<DispatchNamespaceClient<any>>
    >,
    Binding.ServiceLike {
  readonly key: "Cloudflare.WorkersForPlatforms.Get";
  <P extends object = {}>(
    namespace: DispatchBinding["namespace"],
    ...options: GetArgs<P>
  ): DispatchBinding<P>;
}

const GetService = Binding.Service<Get>("Cloudflare.WorkersForPlatforms.Get");

export const Get: Get = taggedFunction(
  GetService as never,
  (namespace: DispatchBinding["namespace"], options?: GetOptions<any>) =>
    // An async Worker's `env` reads the namespace and options off the value;
    // an Effect-native Worker runs it, which hands both to `GetBinding`.
    Object.assign((GetService as any)(namespace, options), {
      "~alchemy/Kind": GetService.key,
      namespace,
      options,
    }),
) as unknown as Get;

/** Structural guard for a {@link DispatchBinding} on an async Worker's `env`. */
export const isDispatchBinding = (value: unknown): value is DispatchBinding<any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as { "~alchemy/Kind"?: unknown })["~alchemy/Kind"] === GetService.key;

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
   *   whose `P` declares values, `outbound` is required.
   */
  get(
    name: string,
    args?: { [key: string]: any },
    ...options: DispatchArgs<P>
  ): Effect.Effect<Fetcher, DispatchNamespaceError, RuntimeContext>;
}
