/**
 * The shared `alchemy/Client` core — the type surface and the factory
 * behind the value form (`createClient(Backend)`).
 *
 * `index.ts` instantiates the factories with a guarded dynamic import of
 * `Server.ts` (the direct in-process dispatch), so importing
 * `alchemy/Client` never statically pulls the serve-bridge graph. The
 * `"browser"` export condition swaps the entry for `browser.ts`, whose
 * `createClient` throws with guidance: schema-less RPC is reserved for
 * trusted (server-side) callers — browsers talk to the backend through a
 * schema the user owns (effect `HttpApi` / `@effect/rpc`) mounted on the
 * backend's `fetch` handler.
 */

import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { RpcClientError } from "./Errors.ts";

// ─────────────────────────────────────────────────────────────────────────
// Type surface
// ─────────────────────────────────────────────────────────────────────────

/**
 * Any effectful Website class — the value default-exported by the user's
 * `src/backend.ts`. The construct signature yields the impl shape; the
 * `Named` phantom brand identifies the class form.
 */
export type AnyBackendClass = {
  readonly "~alchemy/Id": string;
} & (abstract new (_: never) => any);

/** The impl shape carried by a backend class's construct signature. */
export type ClientShape<C> = C extends abstract new (
  ...args: any
) => infer Shape
  ? Shape
  : never;

/**
 * Handler keys that are never RPC methods (mirrors `Serve/Rpc.ts`'s
 * `PLATFORM_HANDLER_KEYS`).
 */
export type PlatformHandlerKey =
  | "fetch"
  | "tail"
  | "trace"
  | "tailStream"
  | "scheduled"
  | "test"
  | "email"
  | "queue";

/**
 * The RPC-dispatchable methods of an impl shape: function-valued keys
 * minus `fetch` and the platform handler keys.
 */
export type RpcMethodShape<Shape> = {
  [K in keyof Shape as K extends PlatformHandlerKey
    ? never
    : K extends string
      ? Shape[K] extends (...args: any[]) => any
        ? K
        : never
      : never]: Shape[K];
};

/** The client-visible success type of a method's return position. */
export type RpcSuccess<R> =
  R extends Effect.Effect<infer A, infer _E, infer _Req>
    ? A
    : R extends Stream.Stream<infer A, infer _E, infer _Req>
      ? A
      : R extends Promise<infer A>
        ? A
        : R;

/**
 * The typed failure of a method's return position — the REAL failure
 * value, thrown/failed as-is by the in-process dispatch.
 */
export type RpcFailure<R> =
  R extends Effect.Effect<infer _A, infer E, infer _Req>
    ? E
    : R extends Stream.Stream<infer _A, infer E, infer _Req>
      ? E
      : never;

/**
 * The Promise-mode client for a backend class: one async method per RPC
 * method of the impl shape. Rejections carry the method's REAL typed
 * failure instance, an {@link RpcClientError}, or the squashed defect.
 */
export type RpcClient<C> = {
  readonly [K in keyof RpcMethodShape<ClientShape<C>>]: RpcMethodShape<
    ClientShape<C>
  >[K] extends (...args: infer Args) => infer Ret
    ? (...args: Args) => Promise<RpcSuccess<Ret>>
    : never;
};

/**
 * The Effect-mode client: methods return `Effect` whose failure channel
 * carries the method's REAL typed failure alongside the client's own
 * {@link RpcClientError}s.
 */
export type RpcEffectClient<C> = {
  readonly [K in keyof RpcMethodShape<ClientShape<C>>]: RpcMethodShape<
    ClientShape<C>
  >[K] extends (...args: infer Args) => infer Ret
    ? (
        ...args: Args
      ) => Effect.Effect<RpcSuccess<Ret>, RpcFailure<Ret> | RpcClientError>
    : never;
};

/** Options for `createClient(Backend, options)`. */
export interface ClientOptions {
  /**
   * Extra headers on every call — cookies/authorization for methods that
   * self-authorize from `HttpServerRequest`. A function is resolved per
   * call, so a module-scope shared client stays per-request-correct with a
   * framework's ambient accessor (TanStack's `getRequestHeaders`, Next's
   * `headers`):
   *
   * ```ts
   * export const backend = createClient(Backend, { headers: getRequestHeaders });
   * ```
   */
  headers?:
    | HeadersInit
    | (() => HeadersInit | undefined | Promise<HeadersInit | undefined>);
}

/** Options for the value (server) form — `createClient(Backend, options)`. */
export interface ServerClientOptions extends ClientOptions {
  /**
   * Explicit environment handed over by the framework (the same handover
   * as `ServeOptions.env`). Default resolution is the serve env ladder:
   * guarded `cloudflare:workers` env → `getCloudflareContext()` global →
   * `process.env`.
   */
  env?: unknown;
}

/** The server-only in-process dispatch injected by `index.ts`. */
export type ServerDispatch = (
  site: object,
  method: string,
  args: readonly unknown[],
  options: ServerClientOptions | undefined,
) => Promise<unknown>;

/**
 * The `createClient` signature (Promise mode): direct in-process dispatch
 * against the backend class — no HTTP, trusted callers only.
 */
export interface CreateClient {
  <C extends AnyBackendClass>(
    backend: C,
    options?: ServerClientOptions,
  ): RpcClient<C>;
}

/** The `createEffectClient` signature (Effect mode). */
export interface CreateEffectClient {
  <C extends AnyBackendClass>(
    backend: C,
    options?: ServerClientOptions,
  ): RpcEffectClient<C>;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve the `headers` option to a concrete `HeadersInit` for ONE call —
 * thunks re-run per call (never captured), keeping a shared client
 * per-request-correct.
 */
export const resolveHeaders = async (
  headers: ClientOptions["headers"],
): Promise<HeadersInit | undefined> =>
  typeof headers === "function" ? headers() : headers;

/**
 * Snapshot a headers thunk SYNCHRONOUSLY at method-call time — before the
 * server dispatch's async boundaries (the guarded dynamic import of
 * `Server.ts`, env/runtime resolution) yield to other requests. A thunk
 * backed by a framework's ambient request accessor (TanStack's
 * `getRequestHeaders`, Next's `headers`) must run in the calling
 * request's synchronous window or concurrent calls cross identities. The
 * thunk fires here (inside `resolveHeaders`, sync up to its first await);
 * downstream consumers get a thunk returning the memoized promise. The
 * no-op catch marks an eventual rejection as observed so a dispatch that
 * throws earlier (e.g. prerender) can't surface it as unhandled.
 */
const snapshotHeaders = (
  options: ServerClientOptions | undefined,
): ServerClientOptions | undefined => {
  if (typeof options?.headers !== "function") {
    return options;
  }
  const promise = resolveHeaders(options.headers);
  promise.catch(() => {});
  return { ...options, headers: () => promise };
};

/**
 * A method-call proxy: every string property is a callable RPC method
 * (cached per name). Promise-introspection keys resolve `undefined` so
 * `await client` and structured logging never trigger a dispatch.
 */
const makeProxy = (
  invoke: (method: string) => (...args: unknown[]) => unknown,
): any => {
  const cache: Record<string, (...args: unknown[]) => unknown> = {};
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (
          typeof prop !== "string" ||
          prop === "then" ||
          prop === "catch" ||
          prop === "finally" ||
          prop === "constructor" ||
          prop === "toJSON"
        ) {
          return undefined;
        }
        return (cache[prop] ??= invoke(prop));
      },
    },
  );
};

const isBackendClass = (value: unknown): value is object =>
  typeof value === "function";

/**
 * The actionable error for a `createClient()` call without a backend
 * class — the removed type-only (browser wire) form.
 */
export const missingBackendError = (): Error =>
  new Error(
    "createClient requires the backend class — createClient(Backend, " +
      "options?) dispatches in-process on the server. Schema-less RPC is " +
      "for trusted, server-side callers only: the browser talks to your " +
      "backend through a schema you own — define an effect HttpApi (or " +
      "@effect/rpc) schema, mount it on the fetch handler, and build the " +
      "client from the schema import.",
  );

// ─────────────────────────────────────────────────────────────────────────
// Factories (instantiated by index.ts)
// ─────────────────────────────────────────────────────────────────────────

/** Build the Promise-mode `createClient` over the server dispatch. */
export const makeCreateClient = (
  serverDispatch: ServerDispatch,
): CreateClient =>
  ((backend?: unknown, options?: unknown): any => {
    if (!isBackendClass(backend)) {
      throw missingBackendError();
    }
    const site = backend;
    const opts = options as ServerClientOptions | undefined;
    return makeProxy(
      (method) =>
        (...args) =>
          serverDispatch(site, method, args, snapshotHeaders(opts)),
    );
  }) as CreateClient;

/** Build the Effect-mode `createEffectClient` over the server dispatch. */
export const makeCreateEffectClient = (
  serverDispatch: ServerDispatch,
): CreateEffectClient =>
  ((backend?: unknown, options?: unknown): any => {
    if (!isBackendClass(backend)) {
      throw missingBackendError();
    }
    const site = backend;
    const opts = options as ServerClientOptions | undefined;
    return makeProxy((method) => (...args) => {
      // The in-process dispatch throws the REAL failure value; keep it
      // as the typed failure channel. Headers snapshot when the effect
      // RUNS (Effect semantics: identity at execution time), still
      // synchronously before the dispatch's async boundaries.
      return Effect.tryPromise({
        try: () => serverDispatch(site, method, args, snapshotHeaders(opts)),
        catch: (error) => error,
      });
    });
  }) as CreateEffectClient;
