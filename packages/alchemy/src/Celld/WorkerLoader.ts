import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { requireDurableObjectHost } from "../Workers/DurableObject.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import type { NativeFetcher } from "./Fetcher.ts";
import {
  fromNativeWorkerEntrypoint,
  type WorkerClassOptions,
  type WorkerEntrypoint,
  type WorkerEntrypointOptions,
  type WorkerInvocationLimits,
} from "./WorkerEntrypoint.ts";

/** A loader operation or synchronous selector failed. */
export class WorkerLoaderError extends Data.TaggedError(
  "Celld.WorkerLoaderError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Celld accepts JavaScript and WebAssembly, not cjs/py/text/data/json wrappers. */
export type WorkerLoaderModule =
  | string
  | { js: string }
  | { wasm: BufferSource };

export interface WorkerLoaderWorkerCode {
  /** Compatibility date for the loaded isolate. */
  compatibilityDate: string;
  /** Compatibility flags passed to native V8. */
  compatibilityFlags?: string[];
  /** JavaScript module containing the default/named exports. */
  mainModule: string;
  /** Module sources. The main module must be JavaScript, not WebAssembly. */
  modules: Record<string, WorkerLoaderModule>;
  /** Structured-clone data and native Service Binding capabilities only. */
  env?: Record<string, unknown>;
  /** Null disables outbound access; a native service/loopback Fetcher routes it. */
  globalOutbound?: NativeFetcher | null;
  /**
   * Per-invocation CPU and subrequest limits enforced by native Celld.
   * getEntrypoint() can further restrict, but cannot raise, these limits.
   */
  limits?: WorkerInvocationLimits;
  /**
   * Native Service Binding Fetchers receiving tail events after loaded fetch
   * invocations. Native Celld delivers tails after the response is available;
   * a tail failure does not change the response. Effect Fetcher wrappers are
   * not native capabilities and must not be passed here.
   */
  tails?: NativeFetcher[];
}

declare const durableObjectClassBrand: unique symbol;
/** Opaque native class token, usable only with state.facets.get(). */
export interface NativeDurableObjectClass {
  readonly [durableObjectClassBrand]: true;
}

export interface NativeLoadedWorker {
  getEntrypoint(
    name?: string | null,
    options?: WorkerEntrypointOptions,
  ): NativeFetcher;
  getDurableObjectClass(
    name?: string | null,
    options?: WorkerClassOptions,
  ): NativeDurableObjectClass;
  /** Schedules native eviction; does not wait for it to finish. */
  dispose(): void;
}

export interface NativeWorkerLoader {
  load(code: WorkerLoaderWorkerCode): NativeLoadedWorker;
  get(
    name: string | null,
    getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>,
  ): NativeLoadedWorker;
}

export interface LoadedWorker {
  /** Select an entrypoint. The loaded-worker handle itself is not a Fetcher. */
  getEntrypoint<Shape = {}>(
    name?: string | null,
    options?: WorkerEntrypointOptions,
  ): Effect.Effect<WorkerEntrypoint<Shape>, WorkerLoaderError, RuntimeContext>;
  getDurableObjectClass(
    name?: string | null,
    options?: WorkerClassOptions,
  ): Effect.Effect<NativeDurableObjectClass, WorkerLoaderError, RuntimeContext>;
  /** Native disposal is fire-and-forget; disposing a named worker does not clear the name cache. */
  dispose(): Effect.Effect<void, WorkerLoaderError, RuntimeContext>;
}

export interface WorkerLoaderClient {
  /** Anonymous handles are disposed when the calling request scope closes. */
  load(
    code: WorkerLoaderWorkerCode,
  ): Effect.Effect<LoadedWorker, WorkerLoaderError, RuntimeContext | Scope>;
  /**
   * Native name memoization survives events. The callback is lazy and runs only
   * for the first name lookup. Keep the returned handle in the calling event;
   * do not dispose a named worker you intend to reuse under the same name.
   */
  get<E = never, R = never>(
    name: string | null,
    getCode: () =>
      | WorkerLoaderWorkerCode
      | Effect.Effect<WorkerLoaderWorkerCode, E, R>,
  ): Effect.Effect<LoadedWorker, WorkerLoaderError, RuntimeContext | R>;
}

const failure = (operation: string) => (cause: unknown) =>
  new WorkerLoaderError({
    message: `Celld WorkerLoader ${operation} failed`,
    cause,
  });

/** @internal */
export const fromNativeLoadedWorker = (
  raw: NativeLoadedWorker,
): LoadedWorker => ({
  getEntrypoint: <Shape = {}>(
    name?: string | null,
    options?: WorkerEntrypointOptions,
  ) =>
    Effect.try({
      try: () =>
        fromNativeWorkerEntrypoint<Shape>(raw.getEntrypoint(name, options)),
      catch: failure("getEntrypoint"),
    }),
  getDurableObjectClass: (name, options) =>
    Effect.try({
      try: () => raw.getDurableObjectClass(name, options),
      catch: failure("getDurableObjectClass"),
    }),
  dispose: () =>
    Effect.try({ try: () => raw.dispose(), catch: failure("dispose") }),
});

/** No native worker is loaded at adapter construction. @internal */
export const fromNativeWorkerLoader = (
  get: () => NativeWorkerLoader,
): WorkerLoaderClient => ({
  load: (code) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => fromNativeLoadedWorker(get().load(code)),
        catch: failure("load"),
      }),
      (worker) =>
        worker
          .dispose()
          .pipe(Effect.catchTag("Celld.WorkerLoaderError", Effect.logWarning)),
    ),
  get: <E, R>(
    name: string | null,
    getCode: () =>
      | WorkerLoaderWorkerCode
      | Effect.Effect<WorkerLoaderWorkerCode, E, R>,
  ) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      return yield* Effect.try({
        try: () =>
          fromNativeLoadedWorker(
            get().get(name, () => {
              const code = getCode();
              return Effect.isEffect(code)
                ? Effect.runPromise(code.pipe(Effect.provide(context)))
                : code;
            }),
          ),
        catch: failure("get"),
      });
    }),
});

/**
 * A native worker_loader binding for Celld V8. Loaded workers support fetch,
 * direct single-method RPC, and facet class tokens, not pipelined RPC or
 * introspection. Native Celld enforces code-size limits and the optional
 * per-invocation cpuMs/subRequests limits. WorkerCode can also supply native
 * Service Binding Fetchers as tails; experimental flags are unsupported.
 * Class and ctx.exports loopback selectors accept props only, not limits.
 *
 * ### Loading a Worker
 * **Example:** Register at init, then load within a request scope
 * ```typescript
 * const loader = yield* Celld.WorkerLoader("LOADER");
 * const handle = yield* loader.load({
 *   compatibilityDate: "2026-09-01",
 *   mainModule: "main.js",
 *   modules: { "main.js": "export default { fetch() { return new Response('ok'); } }" },
 *   globalOutbound: null,
 * });
 * const entrypoint = yield* handle.getEntrypoint();
 * ```
 *
 * ### Limiting Invocations and Delivering Tails
 * **Example:** Load with a native tail capability and stricter entrypoint limits
 * ```typescript
 * // Bind the same-fleet logs Worker at initialization with Celld.FetchBinding.
 * const tail = yield* Celld.Fetch(logs);
 * // Load within a request; source is a WorkerLoaderWorkerCode.
 * const handle = yield* loader.load({
 *   ...source,
 *   limits: { cpuMs: 50, subRequests: 10 },
 *   tails: [tail.raw],
 * });
 * const entrypoint = yield* handle.getEntrypoint("Tool", {
 *   props: { tenant: "example" },
 *   limits: { cpuMs: 20, subRequests: 2 },
 * });
 * ```
 * Native Celld uses the lower value for each limit set on both the code and
 * entrypoint. Limits apply to fetch and RPC; tails report fetch invocations.
 * Tail delivery failures do not change the loaded Worker's response.
 *
 * @binding
 * @product Celld
 */
export const WorkerLoader = (name = "LOADER") =>
  Object.assign(
    Effect.gen(function* () {
      const environment = yield* WorkerEnvironment;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* requireDurableObjectHost(name, "Celld.Worker");
        yield* host.bind`loader:${name}`({
          bindings: [{ type: "worker_loader", name }],
        });
      }
      return fromNativeWorkerLoader(() => {
        const native = environment[name] as NativeWorkerLoader | undefined;
        if (!native)
          throw new Error(`Missing Celld worker_loader binding '${name}'`);
        return native;
      });
    }),
    { "~alchemy/Kind": "Celld.WorkerLoader" as const, "~alchemy/Name": name },
  );
