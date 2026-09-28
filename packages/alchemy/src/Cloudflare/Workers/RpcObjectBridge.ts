import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Pull from "effect/Pull";
import * as Stream from "effect/Stream";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import {
  asEffectOrStream,
  decodeRpcResult,
  encodeRpcError,
  ErrorTag,
  fromRpcStreamEnvelope,
  isRpcStreamEnvelope,
  RpcCallError,
  RpcDecodeError,
  StreamErrorTag,
  StreamTag,
  type RpcStreamEnvelope,
} from "../../Rpc.ts";
import cloudflare_workers from "./cloudflare_workers.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import { WorkerExecutionContext } from "./WorkerRuntime.ts";

const ObjectTag = "~alchemy/rpc/object";
const InvocationTag = "~alchemy/rpc/invocation";
const NativeStreamTag = "~alchemy/rpc/native-stream";
export const NativeInvocation = "__alchemy_rpc_invoke__";

type Operation = (args: unknown[]) => Effect.Effect<any, any, any>;

interface NativeTarget {
  result(args: unknown[]): Promise<unknown>;
  dispatch(method: string): Promise<unknown>;
  release(): Promise<void>;
  status(): Promise<unknown>;
  [Symbol.dispose](): void;
}

interface ObjectEnvelope {
  readonly _tag: typeof ObjectTag;
  readonly methods: string[];
  readonly target: NativeTarget;
}

interface InvocationEnvelope {
  readonly _tag: typeof InvocationTag;
  readonly target: NativeTarget;
}

interface NativeStreamEnvelope {
  readonly _tag: typeof NativeStreamTag;
  readonly target: NativeTarget;
}

type OwnedStreamEnvelope = RpcStreamEnvelope & { readonly owner: NativeTarget };

export const isRpcMethodName = (name: PropertyKey): name is string =>
  typeof name === "string" &&
  name !== "then" &&
  name !== "constructor" &&
  name !== "prototype" &&
  name !== "__proto__" &&
  !Object.hasOwn(Object.prototype, name);

const objectMethods = (value: unknown): string[] | undefined => {
  if (typeof value !== "object" || value === null) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const then = descriptors.then;
  if (
    then &&
    (!Object.hasOwn(then, "value") || typeof then.value === "function")
  ) {
    throw new Error(
      "RPC values cannot expose a callable or accessor then property",
    );
  }
  const names = Reflect.ownKeys(descriptors).filter(
    (name) => name !== Symbol.dispose,
  );
  if (
    !names.some(
      (name) =>
        typeof Object.getOwnPropertyDescriptor(value, name)?.value ===
        "function",
    )
  ) {
    return;
  }
  if (
    names.some(
      (name) =>
        !isRpcMethodName(name) ||
        !Object.hasOwn(descriptors[name], "value") ||
        typeof descriptors[name].value !== "function",
    )
  ) {
    throw new Error(
      "RPC method objects must contain only own, non-reserved method properties",
    );
  }
  return names as string[];
};

export const invokeRpcMethod = (
  shape: object,
  method: string,
  args: unknown[],
): Effect.Effect<any, any, any> =>
  Effect.suspend(() => {
    const field = isRpcMethodName(method)
      ? Object.getOwnPropertyDescriptor(shape, method)
      : undefined;
    if (typeof field?.value !== "function") {
      return Effect.die(new Error(`RPC method "${method}" not found`));
    }
    const result = Reflect.apply(field.value, shape, args);
    return Effect.isEffect(result)
      ? result
      : Stream.isStream(result)
        ? Effect.succeed(result)
        : Effect.die(
            new Error(`RPC method "${method}" must return an Effect or Stream`),
          );
  });

const pinCleanup = (context: Context.Context<any>, promise: Promise<void>) => {
  const handled = promise.catch((error) => {
    console.error("RPC target cleanup failed", error);
  });
  try {
    const state = Context.getOption(context, DurableObjectState);
    if (Option.isSome(state)) {
      state.value.raw.waitUntil(handled);
      return;
    }
    const execution = Context.getOption(context, WorkerExecutionContext);
    if (Option.isSome(execution)) execution.value.raw.waitUntil(handled);
  } catch {
    // Native disposal may run without a live event context to pin.
  }
};

class ServerLifetime {
  readonly children = new Set<ServerLifetime>();
  readonly fibers = new Set<Fiber.Fiber<any, any>>();
  readonly context: Context.Context<any>;
  released = false;
  transferred = false;
  nativeStreams = false;
  deferClose = false;
  completion: Exit.Exit<any, any> | undefined;
  streamFailure: Cause.Cause<unknown> | undefined;
  cancelStream: (() => Promise<void>) | undefined;
  #closing: Promise<void> | undefined;

  constructor(
    readonly scope: Scope.Closeable,
    context: Context.Context<any>,
    readonly parent?: ServerLifetime,
  ) {
    this.context = Context.add(context, Scope.Scope, scope);
    parent?.children.add(this);
  }

  run<A, E>(effect: Effect.Effect<A, E, any>): Promise<Exit.Exit<A, E>> {
    if (this.released)
      return Promise.resolve(
        Exit.die(new Error("RPC object has been released")),
      );
    const fiber = Effect.runFork(
      effect.pipe(Effect.provideContext(this.context)),
    );
    this.fibers.add(fiber);
    return new Promise((resolve) => {
      fiber.addObserver((exit) => {
        this.fibers.delete(fiber);
        resolve(exit);
      });
    });
  }

  invalidate() {
    this.released = true;
    for (const child of this.children) child.invalidate();
  }

  finish(): Promise<void> | undefined {
    if (!this.deferClose) return this.close();
    pinCleanup(
      this.context,
      new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
        this.close(),
      ),
    );
  }

  close(exit?: Exit.Exit<any, any>): Promise<void> {
    if (this.#closing) return this.#closing;
    this.invalidate();
    this.#closing = Promise.resolve().then(async () => {
      try {
        const interrupted = await Effect.runPromiseExit(
          Fiber.interruptAll([...this.fibers]),
        );
        const closed = await Promise.allSettled([
          ...[...this.children].map((child) => child.close(exit)),
          ...(this.cancelStream
            ? [Promise.resolve().then(() => this.cancelStream!())]
            : []),
        ]);
        const finalized = await Effect.runPromiseExit(
          Scope.close(this.scope, exit ?? this.completion ?? Exit.void),
        );
        if (interrupted._tag === "Failure")
          throw Cause.squash(interrupted.cause);
        if (finalized._tag === "Failure") throw Cause.squash(finalized.cause);
        const failure = closed.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      } finally {
        this.parent?.children.delete(this);
      }
    });
    return this.#closing;
  }
}

let TargetClass:
  | (new (
      lifetime: ServerLifetime,
      shape: Record<string, unknown>,
      operation?: Operation,
    ) => NativeTarget)
  | undefined;

const makeTarget = (
  lifetime: ServerLifetime,
  shape: Record<string, unknown>,
  operation?: Operation,
) =>
  Effect.gen(function* () {
    if (TargetClass === undefined) {
      const { RpcTarget } = yield* cloudflare_workers;
      if (RpcTarget === undefined) {
        return yield* Effect.die(
          new Error("RPC method objects require Cloudflare native RPC"),
        );
      }
      TargetClass ??= class extends RpcTarget implements NativeTarget {
        readonly #lifetime: ServerLifetime;
        readonly #shape: Record<string, unknown>;
        readonly #operation: Operation | undefined;
        #result: Promise<unknown> | undefined;

        constructor(
          lifetime: ServerLifetime,
          shape: Record<string, unknown>,
          operation?: Operation,
        ) {
          super();
          this.#lifetime = lifetime;
          this.#shape = shape;
          this.#operation = operation;
        }

        result(args: unknown[]): Promise<unknown> {
          if (this.#lifetime.released)
            return Promise.reject(new Error("RPC object has been released"));
          if (this.#result) return this.#result;
          if (!this.#operation)
            return Promise.reject(new Error("Not an RPC invocation"));
          const call = this.#lifetime;
          let succeeded = false;
          this.#result = call
            .run(
              this.#operation(args).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    call.completion = exit;
                  }),
                ),
                Effect.exit,
                Effect.flatMap((exit) => encodeExit(exit, call)),
              ),
            )
            .then((exit) => {
              if (exit._tag === "Failure") throw Cause.squash(exit.cause);
              if (call.released)
                throw new Error("RPC object has been released");
              succeeded = true;
              return exit.value;
            })
            .finally(() =>
              !succeeded || !call.transferred || call.released
                ? call.finish()
                : undefined,
            );
          return this.#result;
        }

        async dispatch(method: string) {
          if (this.#lifetime.released)
            throw new Error("RPC object has been released");
          const call = new ServerLifetime(
            Scope.makeUnsafe(),
            this.#lifetime.context,
            this.#lifetime,
          );
          try {
            return await Effect.runPromise(
              makeInvocation(
                (args) => invokeRpcMethod(this.#shape, method, args),
                call,
              ),
            );
          } catch (error) {
            await call.close(Exit.die(error));
            throw error;
          }
        }

        release() {
          return this.#lifetime.close();
        }

        status(): Promise<unknown> {
          const cause = this.#lifetime.streamFailure;
          if (cause === undefined) return Promise.resolve(undefined);
          if (Cause.hasDies(cause) || Cause.hasInterrupts(cause))
            return Promise.reject(Cause.squash(cause));
          const failure = cause.reasons.find(Cause.isFailReason);
          return Promise.resolve(
            failure && { _tag: ErrorTag, error: encodeRpcError(failure.error) },
          );
        }

        [Symbol.dispose]() {
          if (!this.#operation || !this.#lifetime.transferred) {
            const cleanup = this.#lifetime.finish();
            if (cleanup) pinCleanup(this.#lifetime.context, cleanup);
          }
        }
      };
    }
    return new TargetClass(lifetime, shape, operation);
  });

const makeInvocation = (
  operation: Operation,
  lifetime: ServerLifetime,
): Effect.Effect<InvocationEnvelope> => {
  lifetime.nativeStreams = true;
  return makeTarget(lifetime, {}, operation).pipe(
    Effect.map(
      (target) =>
        ({
          _tag: InvocationTag,
          target,
        }) satisfies InvocationEnvelope,
    ),
  );
};

export const invokeNativeRpc = (
  shape: object,
  method: string,
  args: unknown[],
) =>
  method === NativeInvocation
    ? prepareNativeRpc((values) =>
        invokeRpcMethod(shape, args[0] as string, values),
      )
    : invokeRpcMethod(shape, method, args);

// The caller acquires a cancellation target before the user effect starts.
export const prepareNativeRpc = (operation: Operation) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const context = (yield* Effect.context<never>()) as Context.Context<any>;
    const lifetime = new ServerLifetime(scope as Scope.Closeable, context);
    lifetime.deferClose = true;
    const envelope = yield* makeInvocation(operation, lifetime);
    EffectHttp.scopeDisableClose(scope);
    return envelope;
  });

const streamError = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasDies(cause) || Cause.hasInterrupts(cause)) return undefined;
  const failure = cause.reasons.find(Cause.isFailReason);
  return (
    failure &&
    JSON.stringify({
      _tag: StreamErrorTag,
      error: encodeRpcError(failure.error),
    }) + "\n"
  );
};

const streamBatchBytes = 1024 * 1024;

const valueSize = (
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): number => {
  if (typeof value === "string") return 32 + value.length * 3;
  if (typeof value === "bigint") return 32 + value.toString().length;
  if (value === null || typeof value !== "object") return 32;
  if (seen.has(value)) return 32;
  if (depth >= 32) return Infinity;
  seen.add(value);
  if (value instanceof ArrayBuffer) return 64 + value.byteLength;
  if (ArrayBuffer.isView(value)) return 64 + value.buffer.byteLength;
  if (value instanceof Date) return 64;
  if (value instanceof RegExp) return 64 + value.source.length * 3;
  let size = 64;
  const add = (item: unknown) => (size += valueSize(item, seen, depth + 1));
  if (value instanceof Map) {
    for (const [key, item] of value) {
      add(key);
      add(item);
      if (size > streamBatchBytes) break;
    }
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) {
      add(item);
      if (size > streamBatchBytes) break;
    }
  } else if (
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null
  ) {
    for (const key of Object.keys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in field)) return Infinity;
      size += 32 + key.length * 3;
      add(field.value);
      if (size > streamBatchBytes) break;
    }
  } else return Infinity;
  return size;
};

const encodeStream = (
  source: Stream.Stream<any, any, any>,
  lifetime: ServerLifetime,
): Effect.Effect<OwnedStreamEnvelope | NativeStreamEnvelope, any, any> =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(source);
    const first = yield* Effect.exit(pull);
    const bytes =
      first._tag === "Success" && first.value[0] instanceof Uint8Array;
    if (!bytes && lifetime.nativeStreams) {
      let pending: typeof first | undefined = first;
      let values: readonly unknown[] = [];
      let offset = 0;
      const next = Effect.gen(function* () {
        if (offset === values.length) {
          const exit = pending ?? (yield* Effect.exit(pull));
          pending = undefined;
          if (exit._tag === "Failure") {
            if (Pull.isDoneCause(exit.cause)) return { done: true, values: [] };
            return yield* Effect.failCause(exit.cause);
          }
          values = exit.value;
          offset = 0;
        }
        let end = offset;
        let size = 0;
        while (end < values.length && end - offset < 128) {
          const nextSize = valueSize(values[end]);
          if (end > offset && size + nextSize > streamBatchBytes) break;
          size += nextSize;
          end++;
          if (size >= streamBatchBytes) break;
        }
        const batch = values.slice(offset, end);
        offset = end;
        return { done: false, values: batch };
      });
      const target = yield* makeTarget(lifetime, { pull: () => next });
      lifetime.transferred = true;
      EffectHttp.scopeDisableClose(lifetime.scope);
      return { _tag: NativeStreamTag, target } satisfies NativeStreamEnvelope;
    }
    const stream =
      first._tag === "Success"
        ? Stream.fromPull(Effect.succeed(pull)).pipe(
            Stream.prepend(first.value),
          )
        : Pull.isDoneCause(first.cause)
          ? Stream.empty
          : Stream.failCause(first.cause);
    const encoded = bytes
      ? (stream as Stream.Stream<Uint8Array, unknown>).pipe(
          Stream.catchCause((cause) => {
            lifetime.streamFailure = cause;
            return lifetime.nativeStreams
              ? Stream.empty
              : Stream.failCause(cause);
          }),
        )
      : stream.pipe(
          Stream.map((value) => JSON.stringify(value) + "\n"),
          Stream.catchCause((cause) => {
            const marker = streamError(cause);
            return marker === undefined
              ? Stream.failCause(cause)
              : Stream.succeed(marker);
          }),
          Stream.encodeText,
        );
    const owner = yield* makeTarget(lifetime, {});
    const reader = Stream.toReadableStreamWith(
      encoded,
      lifetime.context,
    ).getReader();
    lifetime.cancelStream = () => reader.cancel();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              await lifetime.close();
              controller.close();
            } else {
              controller.enqueue(next.value);
            }
          } catch (error) {
            await lifetime.close(Exit.die(error));
            controller.error(error);
          }
        },
        cancel: () => lifetime.close(),
      },
      { highWaterMark: 0 },
    );
    lifetime.transferred = true;
    EffectHttp.scopeDisableClose(lifetime.scope);
    return {
      _tag: StreamTag,
      encoding: bytes ? "bytes" : "jsonl",
      body,
      owner,
    } satisfies OwnedStreamEnvelope;
  });

const encodeExit = (
  exit: Exit.Exit<any, any>,
  lifetime: ServerLifetime,
): Effect.Effect<any, any, any> =>
  Effect.gen(function* () {
    if (exit._tag === "Failure") {
      if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) {
        return yield* Effect.failCause(exit.cause);
      }
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      if (failure)
        return { _tag: ErrorTag, error: encodeRpcError(failure.error) };
      return yield* Effect.failCause(exit.cause);
    }
    if (Stream.isStream(exit.value))
      return yield* encodeStream(exit.value, lifetime);
    const methods = yield* Effect.sync(() => objectMethods(exit.value));
    if (methods === undefined) return exit.value;
    const target = yield* makeTarget(lifetime, exit.value);
    lifetime.transferred = true;
    EffectHttp.scopeDisableClose(lifetime.scope);
    return { _tag: ObjectTag, methods, target } satisfies ObjectEnvelope;
  });

export const handleNativeRpcExit = async (
  exit: Exit.Exit<any, any>,
  scope: Scope.Closeable = Scope.makeUnsafe(),
  context: Context.Context<any> = Context.makeUnsafe(new Map()),
): Promise<any> => {
  if (exit._tag === "Success") {
    if (isInvocationEnvelope(exit.value)) return exit.value;
    if (!Stream.isStream(exit.value) && objectMethods(exit.value) === undefined)
      return exit.value;
  } else {
    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
      throw Cause.squash(exit.cause);
    const failure = exit.cause.reasons.find(Cause.isFailReason);
    if (failure)
      return { _tag: ErrorTag, error: encodeRpcError(failure.error) };
    throw Cause.squash(exit.cause);
  }
  const lifetime = new ServerLifetime(scope, context);
  try {
    const encoded = await lifetime.run(encodeExit(exit, lifetime));
    if (encoded._tag === "Failure") throw Cause.squash(encoded.cause);
    return encoded.value;
  } catch (error) {
    await lifetime.close(Exit.die(error));
    throw error;
  } finally {
    if (!lifetime.transferred) await lifetime.close(exit);
  }
};

const isObjectEnvelope = (value: unknown): value is ObjectEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === ObjectTag;

const isInvocationEnvelope = (value: unknown): value is InvocationEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === InvocationTag;

const isNativeStreamEnvelope = (
  value: unknown,
): value is NativeStreamEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === NativeStreamTag;

const envelopeTarget = (value: unknown): NativeTarget | undefined =>
  isObjectEnvelope(value) ||
  isInvocationEnvelope(value) ||
  isNativeStreamEnvelope(value)
    ? value.target
    : isRpcStreamEnvelope(value) && "owner" in value
      ? (value as OwnedStreamEnvelope).owner
      : undefined;

class ClientLifetime {
  readonly children = new Set<ClientLifetime>();
  released = false;
  #closing: Promise<void> | undefined;

  constructor(
    readonly target: NativeTarget,
    readonly parent?: ClientLifetime,
  ) {
    parent?.children.add(this);
  }

  invalidate() {
    this.released = true;
    for (const child of this.children) child.invalidate();
  }

  disown() {
    if (this.#closing) return;
    this.released = true;
    this.#closing = Promise.resolve();
    this.parent?.children.delete(this);
    this.target[Symbol.dispose]?.();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.invalidate();
    this.#closing = Promise.resolve().then(async () => {
      try {
        const closed = await Promise.allSettled([
          ...[...this.children].map((child) => child.close()),
          Promise.resolve().then(() => this.target.release()),
        ]);
        const failure = closed.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      } finally {
        this.parent?.children.delete(this);
        this.target[Symbol.dispose]?.();
      }
    });
    return this.#closing;
  }
}

const releaseUnclaimed = async (value: unknown) => {
  const target = envelopeTarget(value);
  if (target) await new ClientLifetime(target).close();
  else if (isRpcStreamEnvelope(value)) await value.body.cancel();
};

const decodeNativeResult = (
  value: unknown,
  revive: (error: unknown) => unknown,
  parent?: ClientLifetime,
): Effect.Effect<unknown, unknown> =>
  Effect.gen(function* () {
    const target = envelopeTarget(value);
    if (target === undefined) return yield* decodeRpcResult(value, revive);
    const lifetime = new ClientLifetime(target, parent);
    const scope = yield* Effect.serviceOption(Scope.Scope);
    if (
      Option.isNone(scope) ||
      scope.value.state._tag === "Closed" ||
      parent?.released
    ) {
      yield* Effect.promise(() => lifetime.close());
      return yield* Effect.fail(
        new RpcDecodeError({
          cause: new Error(
            parent?.released
              ? "RPC object has been released"
              : "Returned RPC objects require an ambient Effect Scope",
          ),
        }),
      );
    }
    yield* Scope.addFinalizer(
      scope.value,
      Effect.promise(() => lifetime.close()),
    );
    if (isObjectEnvelope(value)) {
      if (
        !Array.isArray(value.methods) ||
        value.methods.some((method) => !isRpcMethodName(method))
      ) {
        yield* Effect.promise(() => lifetime.close());
        return yield* Effect.fail(
          new RpcDecodeError({
            cause: new Error("Invalid RPC object envelope"),
          }),
        );
      }
      const proxy: Record<string, unknown> = Object.create(null);
      for (const method of value.methods) {
        proxy[method] = (...args: unknown[]) =>
          asEffectOrStream(
            callNativeRpc(
              method,
              () => target.dispatch(method),
              revive,
              lifetime,
              args,
            ),
          );
      }
      return proxy;
    }
    const source = isNativeStreamEnvelope(value)
      ? Stream.fromPull(
          Effect.succeed(
            callNativeRpc(
              "pull",
              () => target.dispatch("pull"),
              revive,
              lifetime,
            ).pipe(
              Effect.flatMap((value) => {
                const batch = value as {
                  done: boolean;
                  values: [unknown, ...unknown[]];
                };
                return batch.done ? Cause.done() : Effect.succeed(batch.values);
              }),
            ),
          ),
        )
      : fromRpcStreamEnvelope(value as OwnedStreamEnvelope).pipe(
          Stream.catchTag("RpcRemoteStreamError", (error) =>
            Stream.fail(revive(error.error)),
          ),
          Stream.catchCause((cause) =>
            Stream.unwrap(
              Effect.tryPromise({
                try: () => target.status(),
                catch: (error) =>
                  new RpcCallError({ method: "stream", cause: error }),
              }).pipe(
                Effect.flatMap((status) =>
                  status === undefined
                    ? Effect.succeed(Stream.failCause(cause))
                    : decodeRpcResult(status, revive).pipe(
                        Effect.as(Stream.empty),
                      ),
                ),
              ),
            ),
          ),
          Stream.concat(
            Stream.fromEffect(
              Effect.tryPromise({
                try: () => target.status(),
                catch: (cause) => new RpcCallError({ method: "stream", cause }),
              }).pipe(
                Effect.flatMap((status) =>
                  status === undefined
                    ? Effect.void
                    : decodeRpcResult(status, revive),
                ),
              ),
            ).pipe(Stream.drain),
          ),
        );
    const stream = source.pipe(
      Stream.onExit(() => Effect.promise(() => lifetime.close())),
    );
    return Stream.suspend(() =>
      lifetime.released
        ? Stream.fail(
            new RpcCallError({
              method: "stream",
              cause: new Error("RPC object has been released"),
            }),
          )
        : stream,
    );
  });

export const callNativeRpc = (
  method: string,
  invoke: () => Promise<unknown>,
  revive: (error: unknown) => unknown,
  parent?: ClientLifetime,
  args: unknown[] = [],
): Effect.Effect<unknown, unknown> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (parent?.released) {
        return yield* Effect.fail(
          new RpcCallError({
            method,
            cause: new Error("RPC object has been released"),
          }),
        );
      }
      const context = (yield* Effect.context<never>()) as Context.Context<any>;
      const request = (invoke: () => Promise<unknown>) =>
        Effect.gen(function* () {
          let received: unknown;
          let settled = false;
          let claimed = false;
          let cleaned = false;
          const cleanup = () => {
            if (settled && !claimed && !cleaned) {
              cleaned = true;
              pinCleanup(context, releaseUnclaimed(received));
            }
          };
          const value = yield* restore(
            Effect.tryPromise({
              try: (signal) => {
                signal.addEventListener("abort", cleanup, { once: true });
                return Promise.resolve(invoke()).then((value) => {
                  received = value;
                  settled = true;
                  if (signal.aborted) cleanup();
                  return value;
                });
              },
              catch: (cause) => new RpcCallError({ method, cause }),
            }),
          );
          claimed = true;
          return value;
        });
      const value = yield* request(invoke);
      if (!isInvocationEnvelope(value))
        return yield* decodeNativeResult(value, revive, parent);
      const control = new ClientLifetime(value.target, parent);
      let completed = false;
      return yield* Effect.gen(function* () {
        if (parent?.released)
          return yield* Effect.fail(
            new RpcCallError({
              method,
              cause: new Error("RPC object has been released"),
            }),
          );
        const result = yield* request(() => value.target.result(args));
        completed = true;
        return yield* decodeNativeResult(result, revive, parent);
      }).pipe(
        Effect.onExit((exit) =>
          completed || Exit.isSuccess(exit)
            ? Effect.sync(() => control.disown())
            : Effect.promise(() => control.close()),
        ),
      );
    }),
  );
