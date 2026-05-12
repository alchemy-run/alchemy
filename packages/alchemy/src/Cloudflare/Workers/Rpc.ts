import type * as cf from "@cloudflare/workers-types";

import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import type { HttpEffect } from "../../Http.ts";
import { isYieldableEffect } from "../../Util/effect.ts";
import { fromCloudflareFetcher } from "../Fetcher.ts";
import { serveWebRequest } from "./HttpServer.ts";
import type { ExtractRpcShape, RpcPromiseShape } from "./InferEnv.ts";
import { fromWebSocket } from "./WebSocket.ts";

export const StreamTag = "~alchemy/rpc/stream";
export const ErrorTag = "~alchemy/rpc/error";
export const StreamErrorTag = "~alchemy/rpc/stream-error";

type StreamEncoding = "bytes" | "jsonl";

export type RpcStreamEnvelope = {
  _tag: typeof StreamTag;
  encoding: StreamEncoding;
  body: ReadableStream<Uint8Array>;
};

export class RpcDecodeError extends Data.TaggedError("RpcDecodeError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

export class RpcCallError extends Data.TaggedError("RpcCallError")<{
  readonly method: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `RPC call to "${this.method}" failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

export class RpcRemoteStreamError extends Data.TaggedError(
  "RpcRemoteStreamError",
)<{
  readonly error: unknown;
}> {}

export type RpcErrorEnvelope = {
  _tag: typeof ErrorTag;
  error: unknown;
};

export type RpcStreamErrorMarker = {
  _tag: typeof StreamErrorTag;
  error: unknown;
};

export const isRpcStreamErrorMarker = (
  value: unknown,
): value is RpcStreamErrorMarker =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === StreamErrorTag &&
  "error" in value;

export const isRpcErrorEnvelope = (value: unknown): value is RpcErrorEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === ErrorTag &&
  "error" in value;

/**
 * Normalize an error value into a plain, structured-clone-safe object.
 * Tagged errors keep `_tag` and all own enumerable fields.
 * Plain `Error` instances keep `name`, `message`, and `stack`.
 */
export const encodeRpcError = (error: unknown): unknown => {
  if (error === null || error === undefined) return error;
  if (typeof error !== "object") return error;

  const obj = error as Record<string, unknown>;
  if ("_tag" in obj && typeof obj._tag === "string") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = obj[key];
    }
    if (error instanceof Error && !("message" in out)) {
      out.message = (error as Error).message;
    }
    return out;
  }

  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }

  return error;
};

export const isRpcStreamEnvelope = (
  value: unknown,
): value is RpcStreamEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === StreamTag &&
  "encoding" in value &&
  (value.encoding === "bytes" || value.encoding === "jsonl") &&
  "body" in value &&
  value.body instanceof ReadableStream;

export const fromRpcReadableStream = (
  body: ReadableStream<Uint8Array>,
  encoding: StreamEncoding,
): Stream.Stream<
  any,
  Socket.SocketError | RpcDecodeError | RpcRemoteStreamError
> => {
  const stream = Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) =>
      Socket.isSocketError(cause)
        ? cause
        : new Socket.SocketError({
            reason: new Socket.SocketReadError({ cause }),
          }),
  });

  if (encoding === "bytes") {
    return stream;
  }

  return stream.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect((line) =>
      Effect.try({
        try: () => JSON.parse(line),
        catch: (cause) => new RpcDecodeError({ cause }),
      }),
    ),
    Stream.flatMap((value) =>
      isRpcStreamErrorMarker(value)
        ? Stream.fail(new RpcRemoteStreamError({ error: value.error }))
        : Stream.succeed(value),
    ),
  );
};

export const fromRpcStreamEnvelope = (
  envelope: RpcStreamEnvelope,
): Stream.Stream<
  any,
  Socket.SocketError | RpcDecodeError | RpcRemoteStreamError
> => fromRpcReadableStream(envelope.body, envelope.encoding);

export const decodeRpcValue = (value: unknown) => {
  if (isRpcStreamEnvelope(value)) {
    return fromRpcReadableStream(value.body, value.encoding);
  }

  if (value instanceof ReadableStream) {
    return fromRpcReadableStream(value, "bytes");
  }

  return value;
};

/**
 * Decode an RPC return value, lifting error envelopes into the Effect
 * error channel so that remote `Effect.fail(...)` values are recoverable.
 */
export const decodeRpcResult = (
  value: unknown,
): Effect.Effect<unknown, unknown> => {
  if (isRpcErrorEnvelope(value)) {
    return Effect.fail(value.error);
  }
  return Effect.succeed(decodeRpcValue(value));
};

/**
 * Wrap a Cloudflare service-binding stub (or an `Effect` that resolves
 * to one — useful when the stub depends on a service like
 * `WorkerEnvironment` that's only available at *exec* phase) into an
 * Effect-typed RPC client.
 *
 * `Service.fetch`/`Service.connect` are passed through eagerly when the
 * stub is already resolved; everything else is treated as an RPC method
 * whose dispatch is deferred until call time, so the user effect runs in
 * the right runtime layer (which is what `bindWorker` actually wants —
 * its methods are called at exec, even though it's *defined* at init).
 */
export const makeRpcStub = <Shape>(
  stubSource: unknown | Effect.Effect<unknown, never, never>,
): Shape => {
  const isLazy = isYieldableEffect(stubSource);
  const eagerFetcher = isLazy
    ? undefined
    : fromCloudflareFetcher(stubSource as cf.Fetcher);
  const proxyTarget: object = eagerFetcher ?? {};

  return new Proxy(proxyTarget, {
    get: (target: any, prop) => {
      if (!isLazy && prop in target) return target[prop];
      if (typeof prop !== "string" && typeof prop !== "symbol") {
        return target[prop];
      }
      return (...args: any[]) =>
        Effect.gen(function* () {
          const stub = isLazy
            ? yield* stubSource as Effect.Effect<any>
            : stubSource;
          return yield* Effect.tryPromise({
            try: () => (stub as any)[prop](...args),
            catch: (cause) => new RpcCallError({ method: String(prop), cause }),
          }).pipe(Effect.flatMap(decodeRpcResult));
        });
    },
  }) as Shape;
};

/**
 * Wrap a raw Cloudflare service binding (the wire-typed view emitted by
 * `InferEnv`) into a Promise-flavored API for non-Effect consumers.
 *
 * Effect-native worker methods serialize their results as envelopes:
 * `Effect.fail` becomes `RpcErrorEnvelope`, `Stream` becomes
 * `RpcStreamEnvelope`, and `Effect.succeed`/raw values pass through. This
 * proxy auto-decodes those envelopes — error envelopes are thrown so the
 * caller's `await` rejects, and stream envelopes are unwrapped to their raw
 * `ReadableStream<Uint8Array>` body.
 *
 * `Service.fetch` and `Service.connect` pass through untouched, so the
 * returned proxy is still a usable `Service` binding.
 *
 * For Effect-to-Effect cross-worker calls, prefer `bindWorker(Worker)` —
 * it preserves typed errors and decoded streams.
 *
 * The generic parameter is the Worker *class* (or its Effect form), the
 * same value you would pass to `bindWorker`. Shape is recovered from the
 * embedded `Rpc<Shape>`.
 *
 * @example
 * ```ts
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import Backend from "./backend.ts";
 *
 * const backend = Cloudflare.toPromiseApi<typeof Backend>(env.BACKEND);
 * const greeting = await backend.hello(key); // throws on Effect.fail
 * ```
 */
export const toPromiseApi = <W>(
  stub: any,
): RpcPromiseShape<ExtractRpcShape<W>> & Service =>
  new Proxy(stub, {
    get: (target, prop) => {
      // `Service` methods (fetch/connect) and any non-string keys (Symbol.dispose, etc.)
      // pass through to the underlying Cloudflare binding unchanged.
      if (typeof prop !== "string" || prop === "fetch" || prop === "connect") {
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }

      return async (...args: unknown[]) => {
        const result = await (target as any)[prop](...args);
        if (isRpcErrorEnvelope(result)) {
          throw decodeRpcThrowable(result.error);
        }
        if (isRpcStreamEnvelope(result)) {
          return result.body;
        }
        return result;
      };
    },
  }) as any;

/**
 * Reconstruct a throwable from {@link encodeRpcError}'s wire form. Plain
 * `Error` payloads are rebuilt as `Error` instances so `.message`/`.name`/
 * `.stack` survive. Tagged errors (anything with a `_tag`) and primitives
 * are thrown as-is so `try { ... } catch (e) { if (e._tag === ...) }` keeps
 * working.
 */
const decodeRpcThrowable = (error: unknown): unknown => {
  if (error === null || typeof error !== "object") return error;
  const obj = error as Record<string, unknown>;
  if ("_tag" in obj) return obj;
  if (typeof obj.message === "string" || typeof obj.name === "string") {
    const e = new Error(typeof obj.message === "string" ? obj.message : "");
    if (typeof obj.name === "string") e.name = obj.name;
    if (typeof obj.stack === "string") e.stack = obj.stack;
    return e;
  }
  return error;
};

/**
 * Create a DurableObjectBridge class that proxies RPC method calls through
 * the Effect runtime, encoding success/fail/stream results as RPC envelopes.
 *
 * Accepts the `DurableObject` base class and a `getExport` resolver so the
 * implementation lives in real TypeScript instead of a generated string template.
 */
export const makeDurableObjectBridge =
  (
    DurableObject: abstract new (
      state: unknown,
      env: unknown,
    ) => cf.DurableObject,
    getExport: (
      name: string,
    ) => Promise<
      (state: unknown, env: unknown) => Effect.Effect<Record<string, unknown>>
    >,
  ) =>
  (className: string) =>
    class DurableObjectBridge extends DurableObject {
      readonly object: Promise<DurableObjectShape>;

      async fetch(request: cf.Request): Promise<cf.Response> {
        const methods = await this.object;
        if (methods.fetch) {
          const fetch = methods.fetch as HttpEffect<never>;
          const response = await serveWebRequest(request, fetch).pipe(
            Effect.runPromise,
          );
          return response as any;
        } else {
          return new Response("Method not found", { status: 404 }) as any;
        }
      }

      async alarm(alarmInfo?: cf.AlarmInvocationInfo) {
        const methods = await this.object;
        if (methods.alarm) {
          await Effect.runPromise(methods.alarm(alarmInfo));
        }
      }

      async webSocketMessage(ws: cf.WebSocket, message: string | ArrayBuffer) {
        const methods = await this.object;
        if (methods.webSocketMessage) {
          const socket = fromWebSocket(ws);
          const value = methods.webSocketMessage(socket, message);
          if (Effect.isEffect(value)) {
            await Effect.runPromise(value as Effect.Effect<void>);
          }
        }
      }

      async webSocketClose(
        ws: cf.WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
      ) {
        const methods = await this.object;
        if (methods.webSocketClose) {
          const socket = fromWebSocket(ws);
          const value = methods.webSocketClose(socket, code, reason, wasClean);
          if (Effect.isEffect(value)) {
            await Effect.runPromise(value as Effect.Effect<void>);
          }
        }
      }

      constructor(
        state: {
          blockConcurrencyWhile: (
            fn: () => Promise<unknown>,
          ) => Promise<unknown>;
        },
        env: unknown,
      ) {
        super(state, env);

        this.object = state.blockConcurrencyWhile(async () => {
          const makeDurableObject = await getExport(className);
          return await Effect.runPromise(makeDurableObject(state, env));
        }) as Promise<any>;

        return new Proxy(this, {
          get: (target: any, prop) =>
            prop in target
              ? target[prop]
              : async (...args: unknown[]) => {
                  const methods = await this.object;
                  const method = methods[
                    prop as keyof DurableObjectShape
                  ] as any; // TODO(sam): what should the type be? Is it safe to always call it?
                  const value = method(...args);
                  if (Effect.isEffect(value)) {
                    const exit = await Effect.runPromiseExit(
                      value as Effect.Effect<unknown, never>,
                    );
                    if (exit._tag === "Success") {
                      if (Stream.isStream(exit.value)) {
                        return await Effect.runPromise(
                          toRpcStream(
                            exit.value,
                          ) as Effect.Effect<RpcStreamEnvelope>,
                        );
                      }
                      return exit.value;
                    }
                    const failReason = exit.cause.reasons.find(
                      Cause.isFailReason,
                    );
                    if (failReason) {
                      return {
                        _tag: ErrorTag,
                        error: encodeRpcError(failReason.error),
                      } satisfies RpcErrorEnvelope;
                    }
                    const dieReason = exit.cause.reasons.find(
                      Cause.isDieReason,
                    );
                    throw (
                      dieReason?.defect ??
                      new Error("RPC method failed with an unexpected cause")
                    );
                  }
                  return value;
                },
        });
      }
    };

/**
 * Create a `WorkerBridge` class — a `WorkerEntrypoint` subclass that
 * Cloudflare instantiates per request and dispatches both standard
 * handlers (`fetch`/`scheduled`/…) and RPC method calls into.
 *
 * The bridge is intentionally layer-ignorant: all runtime-layer plumbing
 * (services, scope, `WorkerExecutionContext`) lives in the platform's
 * `runtimeContext.exports` flow, which builds:
 *
 *   - `getDefault()` → `{ fetch, scheduled, … }` — handler dispatchers
 *     that the bridge forwards `(input, env, ctx)` to.
 *   - `getRpc()`     → `{ method: (args, ctx) => Promise<envelope> }` —
 *     pre-wrapped RPC dispatchers that already run the user effect with
 *     the right runtime layer and envelope-encode the result.
 *
 * Cloudflare's script-validate step requires standard handler methods
 * (`fetch`/`scheduled`/etc.) to be visible on the class prototype. We
 * declare static stubs there and override them per-instance with
 * closure-bound forwarders that capture `ctx`/`env` from the constructor
 * (prototype-level `this` doesn't survive the proxy + RPC dispatch
 * round-trip in some Cloudflare runtime versions).
 */
export const makeWorkerBridge = (
  WorkerEntrypoint: abstract new (
    ctx: unknown,
    env: unknown,
  ) => { fetch?(request: cf.Request): Promise<cf.Response> | cf.Response },
  ExportedHandlerMethods: ReadonlyArray<string>,
  getDefault: () => Promise<Record<string, any>>,
  getRpc: () => Promise<Record<string, any>>,
) => {
  class WorkerBridge extends WorkerEntrypoint {
    constructor(ctx: unknown, env: unknown) {
      super(ctx, env);

      // Override handler methods per-instance with closure-bound forwarders.
      // We read `this.ctx`/`this.env` at *call time* rather than capturing
      // the constructor args because Cloudflare's runtime appears to
      // populate those instance fields differently depending on whether
      // the entrypoint is invoked via direct fetch or RPC — `super(ctx, env)`
      // alone isn't enough to guarantee they survive into the call.
      const self = this as unknown as { ctx: unknown; env: unknown };
      // Cloudflare invokes `WorkerEntrypoint.fetch(request)` with only the
      // primary input on the *parameter list* — `env`/`ctx` live on `this`
      // (and the runtime sometimes passes `(request, undefined, undefined)`
      // anyway for legacy compat). Other handlers, including `scheduled`, may
      // receive the classic `(input, env, ctx)` arguments. The platform's
      // underlying handler dispatch (`handle("fetch")`, `handle("scheduled")`,
      // etc.) follows the plain-export signature `(input, env, context)`, so
      // prefer explicit handler args when Cloudflare provides them and fall
      // back to the WorkerEntrypoint instance fields.
      for (const method of ExportedHandlerMethods) {
        (this as any)[method] = async (
          input: unknown,
          envArg?: unknown,
          ctxArg?: unknown,
        ) => {
          const def = await getDefault();
          return def?.[method]?.(input, envArg ?? self.env, ctxArg ?? self.ctx);
        };
      }

      // RPC method dispatch — anything Cloudflare RPC tries to invoke that
      // isn't an own property goes through the dispatcher table built by
      // the platform's exports flow.
      return new Proxy(this, {
        get: (target, prop) => {
          if (typeof prop !== "string") return (target as any)[prop];
          if (prop in target) return (target as any)[prop];
          return async (...args: unknown[]) => {
            const rpc = await getRpc();
            const dispatcher = rpc?.[prop];
            if (typeof dispatcher !== "function") {
              throw new Error(
                `Method "${prop}" not found on worker. ` +
                  `Make sure it's returned from the worker's default export.`,
              );
            }
            return dispatcher(args, self.ctx);
          };
        },
      });
    }
  }

  // Stub prototype methods so Cloudflare's script-validate detects the
  // standard handler set; per-instance overrides above are what actually
  // run.
  for (const method of ExportedHandlerMethods) {
    Object.defineProperty(WorkerBridge.prototype, method, {
      value: function () {
        throw new Error(
          `Bridge method '${method}' was called before instance setup`,
        );
      },
      writable: true,
      configurable: true,
    });
  }

  return WorkerBridge;
};

/**
 * Create a WorkflowBridge class that extends `WorkflowEntrypoint` and
 * delegates the `run(event, step)` call to the Effect-native workflow body
 * registered via `worker.export(...)`.
 *
 * The bridge provides `WorkflowEvent` and `WorkflowStep` as Effect
 * services so the user writes `yield* WorkflowEvent` and `yield* task(...)`
 * instead of receiving callback parameters.
 */
export const makeWorkflowBridge =
  (
    WorkflowEntrypoint: abstract new (
      ctx: unknown,
      env: unknown,
    ) => { run(event: any, step: any): Promise<unknown> },
    getExport: (
      name: string,
    ) => Promise<
      (
        env: unknown,
      ) => Effect.Effect<(input: unknown) => Effect.Effect<unknown, never, any>>
    >,
  ) =>
  (className: string) =>
    class WorkflowBridge extends WorkflowEntrypoint {
      readonly fn: Promise<
        (input: unknown) => Effect.Effect<unknown, never, any>
      >;
      readonly env: unknown;

      constructor(ctx: unknown, env: unknown) {
        super(ctx, env);
        this.env = env;
        this.fn = getExport(className).then((factory) =>
          Effect.runPromise(factory(env)),
        );
      }

      async run(event: any, step: any): Promise<unknown> {
        const fn = await this.fn;
        return Effect.runPromise(
          fn(event.payload).pipe(
            Effect.provideService(
              WorkflowEventService,
              wrapWorkflowEvent(event),
            ),
            Effect.provideService(WorkflowStep, wrapWorkflowStep(step)),
          ) as Effect.Effect<unknown>,
        );
      }
    };

import type { DurableObjectShape } from "./DurableObjectNamespace.ts";
import {
  WorkflowEvent as WorkflowEventService,
  WorkflowStep,
} from "./Workflow.ts";

const wrapWorkflowEvent = (
  event: any,
): { payload: unknown; timestamp: Date; instanceId: string } => ({
  payload: event.payload,
  timestamp:
    event.timestamp instanceof Date
      ? event.timestamp
      : new Date(event.timestamp),
  instanceId: event.instanceId ?? "",
});

const wrapWorkflowStep = (step: any): WorkflowStep["Service"] => ({
  do: <T>(name: string, effect: Effect.Effect<T>): Effect.Effect<T> =>
    Effect.tryPromise(
      () => step.do(name, () => Effect.runPromise(effect)) as Promise<T>,
    ),
  sleep: (name: string, duration: string | number): Effect.Effect<void> =>
    Effect.tryPromise(() => step.sleep(name, duration)),
  sleepUntil: (name: string, timestamp: Date | number): Effect.Effect<void> =>
    Effect.tryPromise(() =>
      step.sleepUntil(
        name,
        timestamp instanceof Date ? timestamp.toISOString() : timestamp,
      ),
    ),
});

const encodeStreamErrorMarker = (cause: Cause.Cause<unknown>): string => {
  const failReason = cause.reasons.find(Cause.isFailReason);
  const error = failReason ? encodeRpcError(failReason.error) : undefined;
  return (
    JSON.stringify({
      _tag: StreamErrorTag,
      error,
    } satisfies RpcStreamErrorMarker) + "\n"
  );
};

const appendStreamErrors = (s: Stream.Stream<string, unknown>) =>
  s.pipe(
    Stream.catchCause((cause) =>
      Stream.succeed(encodeStreamErrorMarker(cause)),
    ),
  );

export const toRpcStream = (stream: Stream.Stream<any, any, any>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const [head, rest] = yield* Stream.peel(stream, Sink.head());

      if (Option.isSome(head) && head.value instanceof Uint8Array) {
        return {
          _tag: StreamTag,
          encoding: "bytes",
          body: Stream.toReadableStream(
            rest.pipe(Stream.prepend([head.value])),
          ),
        } satisfies RpcStreamEnvelope;
      }

      const body = Option.isSome(head)
        ? rest.pipe(Stream.prepend([head.value]))
        : rest;

      return {
        _tag: StreamTag,
        encoding: "jsonl",
        body: Stream.toReadableStream(
          appendStreamErrors(
            body.pipe(Stream.map((value) => JSON.stringify(value) + "\n")),
          ).pipe(Stream.encodeText),
        ),
      } satisfies RpcStreamEnvelope;
    }),
  ).pipe(
    Effect.catchCause((cause) => {
      const failReason = cause.reasons.find(Cause.isFailReason);
      if (failReason) {
        return Effect.succeed({
          _tag: StreamTag,
          encoding: "jsonl",
          body: Stream.toReadableStream(
            Stream.succeed(encodeStreamErrorMarker(cause)).pipe(
              Stream.encodeText,
            ),
          ),
        } satisfies RpcStreamEnvelope);
      }
      return Effect.die(Cause.squash(cause));
    }),
  );
