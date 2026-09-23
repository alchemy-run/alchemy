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
import { RpcPipelineStart, type RpcPendingCall } from "../../RpcPipeline.ts";
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
  dispatch(path: string | MethodPath): Promise<unknown>;
  release(): Promise<void>;
  status(): Promise<unknown>;
  [Symbol.dispose](): void;
}

/** Where a method sits inside a returned value, e.g. `["stats", "current"]`. */
type MethodPath = ReadonlyArray<string | number>;

interface ObjectEnvelope {
  readonly _tag: typeof ObjectTag;
  /** The returned value with its methods removed. */
  readonly data: object;
  readonly methods: MethodPath[];
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

const maxValueDepth = 256;

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isPlainArray = (value: object): value is unknown[] =>
  Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;

const tooDeep = () =>
  new Error(`RPC values cannot be nested deeper than ${maxValueDepth} levels`);

/**
 * Find every method in a returned value by walking its plain objects and
 * arrays. Returns undefined for plain data, which is sent unchanged.
 * Property getters are never invoked.
 */
const findMethods = (root: unknown): MethodPath[] | undefined => {
  if (typeof root !== "object" || root === null) return;
  const methods: MethodPath[] = [];
  const seen = new WeakSet<object>();
  const pending: Array<{ value: object; path: MethodPath }> = [
    { value: root, path: [] },
  ];
  while (pending.length > 0) {
    const { value, path } = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (path.length > maxValueDepth) throw tooDeep();
    const visit = (key: string | number, member: unknown) => {
      if (typeof member === "function") methods.push([...path, key]);
      else if (typeof member === "object" && member !== null)
        pending.push({ value: member, path: [...path, key] });
    };
    if (isPlainArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const field = Object.getOwnPropertyDescriptor(value, index);
        if (field && "value" in field) visit(index, field.value);
      }
    } else if (isPlainObject(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const then = descriptors.then;
      if (then && (!("value" in then) || typeof then.value === "function")) {
        throw new Error(
          "RPC values cannot expose a callable or accessor then property",
        );
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === Symbol.dispose) continue;
        const field = descriptors[key as keyof typeof descriptors];
        if (!("value" in field)) continue;
        if (typeof field.value === "function" && !isRpcMethodName(key)) {
          throw new Error(
            `RPC methods must have a non-reserved string name; found ${String(key)}`,
          );
        }
        if (typeof key === "string") visit(key, field.value);
      }
    }
  }
  return methods.length > 0 ? methods : undefined;
};

/**
 * Copy a returned value without its methods, preserving shared references
 * and cycles. Only called for values that contain methods.
 */
const stripMethods = (root: object): object => {
  const copies = new Map<object, object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const existing = copies.get(value);
    if (existing !== undefined) return existing;
    if (depth > maxValueDepth) throw tooDeep();
    if (isPlainArray(value)) {
      const out: unknown[] = new Array(value.length);
      copies.set(value, out);
      for (let index = 0; index < value.length; index++) {
        const field = Object.getOwnPropertyDescriptor(value, index);
        if (!field) continue;
        if (!("value" in field)) throw accessorError();
        out[index] =
          typeof field.value === "function"
            ? undefined
            : copy(field.value, depth + 1);
      }
      return out;
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = Object.create(
        Object.getPrototypeOf(value),
      );
      copies.set(value, out);
      for (const [key, field] of Object.entries(
        Object.getOwnPropertyDescriptors(value),
      )) {
        if (!field.enumerable) continue;
        if (!("value" in field)) throw accessorError();
        if (typeof field.value === "function") continue;
        out[key] = copy(field.value, depth + 1);
      }
      return out;
    }
    return value;
  };
  return copy(root, 0) as object;
};

const accessorError = () =>
  new Error("RPC values with methods cannot contain property getters");

const isMethodPath = (path: unknown): path is MethodPath =>
  Array.isArray(path) &&
  path.length > 0 &&
  path.every((segment) =>
    typeof segment === "number"
      ? Number.isInteger(segment) && segment >= 0
      : isRpcMethodName(segment),
  );

const ownField = (container: unknown, segment: string | number) => {
  if (typeof container !== "object" || container === null) return undefined;
  if (!isPlainArray(container) && !isPlainObject(container)) return undefined;
  const field = Object.getOwnPropertyDescriptor(container, segment);
  return field && "value" in field ? field : undefined;
};

/** Call the method at `path` inside a returned value. */
const invokeRpcPath = (
  root: object,
  path: MethodPath,
  args: unknown[],
): Effect.Effect<any, any, any> =>
  Effect.suspend(() => {
    const label = path.join(".");
    if (!isMethodPath(path))
      return Effect.die(new Error(`Invalid RPC method path "${label}"`));
    let parent: unknown = root;
    for (const segment of path.slice(0, -1)) {
      parent = ownField(parent, segment)?.value;
    }
    const method = ownField(parent, path.at(-1)!)?.value;
    if (typeof method !== "function") {
      return Effect.die(new Error(`RPC method "${label}" not found`));
    }
    const result = Reflect.apply(method, parent, args);
    return Effect.isEffect(result)
      ? result
      : Stream.isStream(result)
        ? Effect.succeed(result)
        : Effect.die(
            new Error(`RPC method "${label}" must return an Effect or Stream`),
          );
  });

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
      shape: object,
      operation?: Operation,
    ) => NativeTarget)
  | undefined;

const makeTarget = (
  lifetime: ServerLifetime,
  shape: object,
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
        readonly #shape: object;
        readonly #operation: Operation | undefined;
        #result: Promise<unknown> | undefined;

        constructor(
          lifetime: ServerLifetime,
          shape: object,
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

        async dispatch(path: string | MethodPath) {
          if (this.#lifetime.released)
            throw new Error("RPC object has been released");
          const call = new ServerLifetime(
            Scope.makeUnsafe(),
            this.#lifetime.context,
            this.#lifetime,
          );
          const methodPath = typeof path === "string" ? [path] : path;
          try {
            return await Effect.runPromise(
              makeInvocation(
                (args) => invokeRpcPath(this.#shape, methodPath, args),
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
    const methods = yield* Effect.sync(() => findMethods(exit.value));
    if (methods === undefined) return exit.value;
    const data = yield* Effect.sync(() => stripMethods(exit.value));
    const target = yield* makeTarget(lifetime, exit.value);
    lifetime.transferred = true;
    EffectHttp.scopeDisableClose(lifetime.scope);
    return {
      _tag: ObjectTag,
      data,
      methods,
      target,
    } satisfies ObjectEnvelope;
  });

export const handleNativeRpcExit = async (
  exit: Exit.Exit<any, any>,
  scope: Scope.Closeable = Scope.makeUnsafe(),
  context: Context.Context<any> = Context.makeUnsafe(new Map()),
): Promise<any> => {
  if (exit._tag === "Success") {
    if (isInvocationEnvelope(exit.value)) return exit.value;
    if (!Stream.isStream(exit.value) && findMethods(exit.value) === undefined)
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

const invalidEnvelope = () =>
  new RpcDecodeError({ cause: new Error("Invalid RPC object envelope") });

/** Put a remote method at each of the envelope's method paths. */
const rebuildObject = (
  envelope: ObjectEnvelope,
  makeMethod: (path: MethodPath) => (...args: unknown[]) => unknown,
): object | undefined => {
  const { data, methods } = envelope;
  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray(methods) ||
    !methods.every(isMethodPath)
  )
    return;
  for (const path of methods) {
    let parent: any = data;
    for (const segment of path.slice(0, -1)) {
      parent = parent[segment];
      if (typeof parent !== "object" || parent === null) return;
    }
    parent[path.at(-1)!] = makeMethod(path);
  }
  return data;
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
      const object = rebuildObject(
        value,
        (path) =>
          (...args: unknown[]) =>
            nativeCall(
              path.join("."),
              dispatchStart(target, path, args),
              revive,
              lifetime,
            ),
      );
      if (object === undefined) {
        yield* Effect.promise(() => lifetime.close());
        return yield* Effect.fail(invalidEnvelope());
      }
      return object;
    }
    const source = isNativeStreamEnvelope(value)
      ? Stream.fromPull(
          Effect.succeed(
            nativeCall(
              "pull",
              dispatchStart(target, ["pull"], []),
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

/** A native call that has been sent but not awaited. */
export interface NativeStart {
  /** The pending result; calls on it are pipelined. */
  readonly pending: any;
  /** Settles with the final wire value. */
  readonly settled: PromiseLike<unknown>;
  /** The pending invocation, released if the caller abandons the call. */
  readonly control?: any;
}

/** Adapt a pending invocation so a ClientLifetime can release or drop it. */
const pendingControl = (invocation: any): NativeTarget =>
  ({
    release: () =>
      Promise.resolve(invocation.target.release()).then(
        () => undefined,
        () => undefined,
      ),
    [Symbol.dispose]: () => invocation[Symbol.dispose]?.(),
  }) as unknown as NativeTarget;

const releasedError = (method: string) =>
  new RpcCallError({
    method,
    cause: new Error("RPC object has been released"),
  });

/** Call the method at `path` on a (possibly still pending) remote target. */
const dispatchStart = (
  target: any,
  path: MethodPath,
  args: unknown[],
): Effect.Effect<NativeStart, RpcCallError> =>
  Effect.try({
    try: () => {
      const invocation = target.dispatch(path);
      const pending = invocation.target.result(args);
      return { pending, settled: pending, control: invocation };
    },
    catch: (cause) => new RpcCallError({ method: path.join("."), cause }),
  });

const settleNative = (
  method: string,
  started: NativeStart,
  revive: (error: unknown) => unknown,
  parent: ClientLifetime | undefined,
  context: Context.Context<any>,
  restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
): Effect.Effect<unknown, unknown> => {
  const control =
    started.control === undefined
      ? undefined
      : new ClientLifetime(pendingControl(started.control), parent);
  let completed = false;
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
  return restore(
    Effect.tryPromise({
      try: (signal) => {
        signal.addEventListener("abort", cleanup, { once: true });
        return Promise.resolve(started.settled).then((value) => {
          received = value;
          settled = true;
          if (signal.aborted) cleanup();
          return value;
        });
      },
      catch: (cause) => new RpcCallError({ method, cause }),
    }),
  ).pipe(
    Effect.flatMap((value) => {
      claimed = true;
      completed = true;
      return decodeNativeResult(value, revive, parent);
    }),
    Effect.onExit((exit) =>
      control === undefined
        ? Effect.void
        : completed || Exit.isSuccess(exit)
          ? Effect.sync(() => control.disown())
          : Effect.promise(() => control.close()),
    ),
  );
};

/**
 * An RPC call as an Effect (or Stream). Running it sends the call and waits
 * for the result. `Rpc.pipeline` can instead start it and send further calls
 * on its result before it arrives.
 */
export const nativeCall = (
  method: string,
  start: Effect.Effect<NativeStart, unknown>,
  revive: (error: unknown) => unknown,
  parent?: ClientLifetime,
): Effect.Effect<unknown, unknown> => {
  const begin = Effect.gen(function* () {
    if (parent?.released) return yield* Effect.fail(releasedError(method));
    const started = yield* start;
    const context = (yield* Effect.context<never>()) as Context.Context<any>;
    return { started, context };
  });
  const call = Effect.uninterruptibleMask((restore) =>
    begin.pipe(
      Effect.flatMap(({ started, context }) =>
        settleNative(method, started, revive, parent, context, restore),
      ),
    ),
  );
  return Object.assign(asEffectOrStream(call), {
    [RpcPipelineStart]: begin.pipe(
      Effect.map(({ started, context }): RpcPendingCall => ({
        result: Effect.uninterruptibleMask((restore) =>
          settleNative(method, started, revive, parent, context, restore),
        ),
        call: (path, args) =>
          nativeCall(
            `${method}.${path.join(".")}`,
            Effect.suspend(() =>
              dispatchStart(started.pending.target, path, [...args]),
            ),
            revive,
          ),
      })),
    ),
  });
};

const isMissingInvocation = (error: unknown) =>
  error instanceof Error &&
  (error.message ===
    `The RPC receiver does not implement the method "${NativeInvocation}".` ||
    error.message ===
      `Method "${NativeInvocation}" not found on worker. Make sure it's returned from the worker's default export.`);

/**
 * Start a call on a Worker or Durable Object stub. Alchemy hosts get the
 * cancellable invocation entrypoint, with the result call pipelined onto it;
 * receivers predating that entrypoint fall back to a direct call.
 */
export const startRootCall = (
  stub: any,
  method: string,
  args: unknown[],
  invocations: boolean | undefined,
): NativeStart => {
  if (!invocations) {
    const pending = stub[method](...args);
    return { pending, settled: pending };
  }
  const invocation = stub[NativeInvocation](method);
  const pending = invocation.target.result(args);
  const settled = Promise.resolve(pending).catch(async (error) => {
    const outcome = await Promise.resolve(invocation).then(
      (value: unknown) => ({ legacy: value === undefined }),
      (reason: unknown) => ({ legacy: isMissingInvocation(reason) }),
    );
    if (outcome.legacy) return stub[method](...args);
    throw error;
  });
  return { pending, settled, control: invocation };
};
