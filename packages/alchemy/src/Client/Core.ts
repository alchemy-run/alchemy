/**
 * The shared `alchemy/Client` core — everything `createClient` needs in
 * BOTH worlds (browser and server), parameterized over the server-only
 * in-process dispatch so the browser build of this subpath carries zero
 * backend bytes.
 *
 * The two entry modules instantiate it:
 *
 *   - `index.ts` (default) injects a guarded dynamic import of
 *     `Server.ts` — the direct in-process dispatch used by the value form
 *     (`createClient(Backend)`) in SSR/server code.
 *   - `browser.ts` (the `"browser"` export condition) injects nothing —
 *     every call takes the HTTP path of the wire protocol.
 *
 * Wire protocol (v1, plain JSON — see `Serve/Rpc.ts`):
 * `POST {RPC_PATH}/<method>` with a JSON array body of positional args;
 * `200 {"value"}` → success, `{"error"}` → typed failure (decoded
 * structurally, carrying `_tag` + props), `{"defect"}` → sanitized
 * defect.
 *
 * This module must have NO static imports of server-only modules (the
 * `Serve/Rpc.ts` import below is type-only and erased).
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { RPC_PATH as RPC_PATH_TYPE } from "../Serve/Rpc.ts";
import {
  decodeRpcErrorPayload,
  RpcDefectError,
  RpcMissingUrlError,
  RpcTransportError,
  type RpcClientError,
} from "./Errors.ts";

/**
 * The universal RPC dispatch prefix — a literal twin of
 * `Serve/Rpc.ts`'s `RPC_PATH` (type-checked against it; the import above
 * is type-only so the client stays free of server-module bytes).
 */
const RPC_PATH: typeof RPC_PATH_TYPE = "/api/__rpc";

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
 * The typed failure of a method's return position — decoded structurally
 * on the HTTP path (see `RpcError`), the real failure value on the
 * in-process path.
 */
export type RpcFailure<R> =
  R extends Effect.Effect<infer _A, infer E, infer _Req>
    ? E
    : R extends Stream.Stream<infer _A, infer E, infer _Req>
      ? E
      : never;

/**
 * The Promise-mode client for a backend class: one async method per RPC
 * method of the impl shape. Rejections carry the decoded envelope — an
 * `RpcError` re-carrying the typed failure's `_tag` + props, an
 * `RpcDefectError`, or a transport/world error.
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
 * carries the decoded envelope (the method's typed failure, structurally)
 * alongside the client's own {@link RpcClientError}s.
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

/** Options shared by both `createClient` forms. */
export interface ClientOptions {
  /**
   * Origin (or full base URL) the wire calls POST to. Defaults to
   * `location.origin` in the browser; required when the type-only form
   * runs anywhere else.
   */
  url?: string;
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
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /**
   * Wrap the underlying `HttpClient` (HTTP path only) — retries, extra
   * headers, tracing.
   */
  transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
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

/**
 * The server-only in-process dispatch injected by `index.ts` (absent in
 * the browser build).
 */
export type ServerDispatch = (
  site: object,
  method: string,
  args: readonly unknown[],
  options: ServerClientOptions | undefined,
) => Promise<unknown>;

/** The `createClient` overloads (Promise mode). */
export interface CreateClient {
  /**
   * Value form (server/SSR): direct in-process dispatch against the
   * backend class — no HTTP.
   */
  <C extends AnyBackendClass>(
    backend: C,
    options?: ServerClientOptions,
  ): RpcClient<C>;
  /**
   * Type-only form (browser/client components):
   * `createClient<typeof Backend>()` — HTTP per the wire protocol, zero
   * backend bytes in the bundle.
   */
  <C extends AnyBackendClass = never>(options?: ClientOptions): RpcClient<C>;
}

/** The `createEffectClient` overloads (Effect mode). */
export interface CreateEffectClient {
  <C extends AnyBackendClass>(
    backend: C,
    options?: ServerClientOptions,
  ): RpcEffectClient<C>;
  <C extends AnyBackendClass = never>(
    options?: ClientOptions,
  ): RpcEffectClient<C>;
}

// ─────────────────────────────────────────────────────────────────────────
// World detection + wire call
// ─────────────────────────────────────────────────────────────────────────

const globals = globalThis as {
  document?: unknown;
  location?: { origin?: unknown };
};

/**
 * A genuine browser world (a real DOM). Workerd, Node, Bun, and Lambda
 * sandboxes have no `document`.
 */
const isBrowserWorld = (): boolean =>
  globals.document !== undefined && globals.location !== undefined;

const locationOrigin = (): string | undefined =>
  typeof globals.location?.origin === "string"
    ? globals.location.origin
    : undefined;

const resolveBase = (
  options: ClientOptions | undefined,
): string | RpcMissingUrlError => {
  if (options?.url !== undefined && options.url.length > 0) {
    return options.url.replace(/\/+$/, "");
  }
  const origin = locationOrigin();
  if (origin !== undefined) {
    return origin;
  }
  return new RpcMissingUrlError({
    message:
      "createClient() has no URL to call outside the browser: on the " +
      "server pass the Backend class for direct in-process dispatch — " +
      "createClient(Backend) — or provide options.url.",
  });
};

const headersToRecord = (
  init: HeadersInit | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (init !== undefined) {
    new Headers(init).forEach((value, key) => {
      out[key] = value;
    });
  }
  return out;
};

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
const snapshotHeaders = <O extends ClientOptions | undefined>(
  options: O,
): O => {
  if (typeof options?.headers !== "function") {
    return options;
  }
  const promise = resolveHeaders(options.headers);
  promise.catch(() => {});
  return { ...options, headers: () => promise };
};

/** Decode one wire response per the envelope protocol. */
const decodeEnvelope = (
  method: string,
  status: number,
  text: string,
): Effect.Effect<unknown, unknown> =>
  Effect.suspend(() => {
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      return Effect.fail(
        new RpcTransportError({
          method,
          message:
            `the server answered ${status} with a non-JSON body — is the ` +
            "backend deployed and the URL correct?",
        }),
      );
    }
    if (parsed !== null && typeof parsed === "object") {
      const envelope = parsed as Record<string, unknown>;
      if ("value" in envelope) {
        return Effect.succeed(envelope.value);
      }
      if ("error" in envelope) {
        return Effect.fail(decodeRpcErrorPayload(envelope.error));
      }
      if ("defect" in envelope) {
        const defect = envelope.defect as { message?: unknown } | null;
        return Effect.fail(
          new RpcDefectError({
            method,
            message:
              typeof defect?.message === "string"
                ? defect.message
                : "the backend method died with a defect",
          }),
        );
      }
    }
    return Effect.fail(
      new RpcTransportError({
        method,
        message: `the server answered ${status} with an unrecognized body — is the backend an effectful Website?`,
      }),
    );
  });

/**
 * One wire call: `POST {base}{RPC_PATH}/{method}` with the JSON array of
 * positional args, decoded per the envelope protocol. Failure channel:
 * the decoded typed failure (structural), or an {@link RpcClientError}.
 */
const httpCall = (
  method: string,
  args: readonly unknown[],
  options: ClientOptions | undefined,
): Effect.Effect<unknown, unknown> =>
  Effect.suspend(() => {
    const base = resolveBase(options);
    if (typeof base !== "string") {
      return Effect.fail(base);
    }
    let body: string;
    try {
      body = JSON.stringify(args);
    } catch (cause) {
      return Effect.fail(
        new RpcTransportError({
          method,
          message:
            "the RPC arguments are not JSON-serializable (v1 wire protocol is plain JSON)",
          cause,
        }),
      );
    }
    return Effect.gen(function* () {
      const base_ = yield* HttpClient.HttpClient;
      const client =
        options?.transformClient !== undefined
          ? options.transformClient(base_)
          : base_;
      const resolvedHeaders = yield* Effect.promise(() =>
        resolveHeaders(options?.headers),
      );
      const request = HttpClientRequest.post(
        `${base}${RPC_PATH}/${encodeURIComponent(method)}`,
      ).pipe(
        HttpClientRequest.setHeaders(headersToRecord(resolvedHeaders)),
        HttpClientRequest.bodyText(body, "application/json"),
      );
      const response = yield* client.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new RpcTransportError({
              method,
              message: "the RPC request failed to send",
              cause,
            }),
        ),
      );
      const text = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new RpcTransportError({
              method,
              message: "failed to read the RPC response body",
              cause,
            }),
        ),
      );
      return yield* decodeEnvelope(method, response.status, text);
    }).pipe(Effect.provide(FetchHttpClient.layer));
  });

/**
 * Run a client-call effect as a Promise whose rejection is the FAILURE
 * VALUE itself (the decoded envelope / typed error), never a wrapped
 * FiberFailure.
 */
const runAsPromise = (
  effect: Effect.Effect<unknown, unknown>,
): Promise<unknown> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (exit._tag === "Success") {
      return exit.value;
    }
    const fail = exit.cause.reasons.find(Cause.isFailReason);
    throw fail !== undefined ? fail.error : Cause.squash(exit.cause);
  });

/**
 * A method-call proxy: every string property is a callable RPC method
 * (cached per name). Promise-introspection keys resolve `undefined` so
 * `await client` and structured logging never trigger a wire call.
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

// ─────────────────────────────────────────────────────────────────────────
// Factories (instantiated by index.ts / browser.ts)
// ─────────────────────────────────────────────────────────────────────────

/** Build the Promise-mode `createClient` over an optional server dispatch. */
export const makeCreateClient = (
  serverDispatch: ServerDispatch | undefined,
): CreateClient =>
  ((first?: unknown, second?: unknown): any => {
    if (isBackendClass(first)) {
      // Value form: direct in-process dispatch on the server; in a
      // genuine browser world (or a build without the server branch)
      // fall back to the HTTP path — harmless, same protocol.
      const site = first;
      const options = second as ServerClientOptions | undefined;
      return makeProxy((method) => (...args) => {
        if (serverDispatch !== undefined && !isBrowserWorld()) {
          return serverDispatch(site, method, args, snapshotHeaders(options));
        }
        return runAsPromise(httpCall(method, args, options));
      });
    }
    // Type-only form: always HTTP.
    const options = first as ClientOptions | undefined;
    return makeProxy(
      (method) =>
        (...args) =>
          runAsPromise(httpCall(method, args, options)),
    );
  }) as CreateClient;

/** Build the Effect-mode `createEffectClient` over an optional server dispatch. */
export const makeCreateEffectClient = (
  serverDispatch: ServerDispatch | undefined,
): CreateEffectClient =>
  ((first?: unknown, second?: unknown): any => {
    if (isBackendClass(first)) {
      const site = first;
      const options = second as ServerClientOptions | undefined;
      return makeProxy((method) => (...args) => {
        if (serverDispatch !== undefined && !isBrowserWorld()) {
          // The in-process dispatch throws the REAL failure value; keep
          // it as the typed failure channel. Headers snapshot when the
          // effect RUNS (Effect semantics: identity at execution time),
          // still synchronously before the dispatch's async boundaries.
          return Effect.tryPromise({
            try: () =>
              serverDispatch(site, method, args, snapshotHeaders(options)),
            catch: (error) => error,
          });
        }
        return httpCall(method, args, options);
      });
    }
    const options = first as ClientOptions | undefined;
    return makeProxy(
      (method) =>
        (...args) =>
          httpCall(method, args, options),
    );
  }) as CreateEffectClient;
