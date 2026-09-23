import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { dual } from "effect/Function";
import type * as Scope from "effect/Scope";

/**
 * @internal Present on RPC call Effects whose transport can start the call
 * without waiting for it, so calls on its result travel in the same round trip.
 */
export const RpcPipelineStart: unique symbol = Symbol.for(
  "alchemy/rpc/pipeline-start",
) as never;

/** @internal A started RPC call whose result has not arrived yet. */
export interface RpcPendingCall {
  /** Wait for the result and decode it into the ambient Scope. Run once. */
  readonly result: Effect.Effect<unknown, unknown>;
  /** Call the method at `path` on the pending result without waiting for it. */
  readonly call: (
    path: ReadonlyArray<string>,
    args: ReadonlyArray<unknown>,
  ) => unknown;
}

/** @internal */
export interface RpcPipelineSource {
  readonly [RpcPipelineStart]: Effect.Effect<RpcPendingCall, unknown>;
}

type AnyMethod = (...args: never[]) => unknown;

type PendingLeaf =
  | Date
  | RegExp
  | ArrayBuffer
  | ArrayBufferView
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | Error
  | Blob
  | Request
  | Response
  | ReadableStream
  | WritableStream
  | Headers;

type PendingField<V> = V extends AnyMethod
  ? V
  : V extends PendingLeaf
    ? Effect.Effect<V>
    : V extends ReadonlyArray<infer Element>
      ? {
          readonly [index: number]: PendingField<Element>;
          readonly length: Effect.Effect<number>;
        } & Effect.Effect<V>
      : V extends object
        ? Pending<V> & Effect.Effect<V>
        : Effect.Effect<V>;

/**
 * The view of an RPC result that has not arrived yet, as seen inside
 * {@link pipeline}. Methods keep their exact types, including generics and
 * overloads. Data fields become Effects that wait for the result. Nested
 * objects can be read whole with `yield*` or navigated field by field.
 */
export type Pending<T> = 0 extends 1 & T
  ? any
  : {
      readonly [
        K in keyof T as K extends `~${string}` ? never : K
      ]: PendingField<T[K]>;
    };

type Path = ReadonlyArray<string>;

const readPath = (value: unknown, path: Path): unknown => {
  let current: any = value;
  for (const segment of path) current = current?.[segment];
  return current;
};

/**
 * A callable Proxy that is also an Effect: calling it invokes the method at
 * `path`, `yield*`-ing it reads the data at `path`, and any other property
 * access navigates one level deeper.
 */
const makeView = (
  read: (path: Path) => Effect.Effect<unknown, unknown>,
  call: (path: Path, args: ReadonlyArray<unknown>) => unknown,
  path: Path = [],
): any => {
  const effect = read(path);
  const children = new Map<string, unknown>();
  return new Proxy(function pending() {}, {
    apply: (_target, _this, args) => call(path, args),
    get: (_target, key) => {
      // Effect probes values through `~effect/...` type-id keys.
      if (typeof key === "symbol" || key.startsWith("~") || key in effect)
        return (effect as any)[key];
      if (key === "then") return undefined;
      let child = children.get(key);
      if (child === undefined) {
        child = makeView(read, call, [...path, key]);
        children.set(key, child);
      }
      return child;
    },
    has: (_target, key) => key in effect,
  });
};

const resolvedView = (value: unknown) =>
  makeView(
    (path) => Effect.sync(() => readPath(value, path)),
    (path, args) =>
      (readPath(value, path.slice(0, -1)) as any)[path.at(-1)!](...args),
  );

const pipelineImpl = <A, E1, R1, B, E2, R2>(
  self: Effect.Effect<A, E1, R1>,
  f: (value: Pending<A>) => Effect.Effect<B, E2, R2>,
): Effect.Effect<B, E1 | E2, Exclude<R1 | R2, Scope.Scope>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const start = (self as Partial<RpcPipelineSource>)[RpcPipelineStart];
      if (start === undefined) {
        const value = yield* self;
        return yield* f(resolvedView(value));
      }
      const { pending, first } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const pending = yield* start;
          const first = yield* Effect.forkScoped(pending.result);
          return { pending, first };
        }),
      );
      const view = makeView(
        (path) =>
          Fiber.join(first).pipe(Effect.map((value) => readPath(value, path))),
        pending.call,
      );
      const exit = yield* Effect.exit(f(view));
      const firstExit = yield* Fiber.await(first);
      if (Exit.isFailure(firstExit))
        return yield* Effect.failCause(firstExit.cause);
      return yield* exit;
    }),
  ) as Effect.Effect<B, E1 | E2, Exclude<R1 | R2, Scope.Scope>>;

/**
 * Call methods on the result of an RPC call before it arrives. The first call
 * and every call made on its result inside `f` travel together, so the chain
 * costs one round trip.
 *
 * Inside `f` the result is a {@link Pending} view: methods keep their exact
 * types, and data fields are Effects that wait for the result. The result is
 * released when the Effect returned by `f` finishes, and running the pipeline
 * again runs the whole chain again.
 *
 * Effects that do not come from an RPC call run in order, as with
 * `Effect.flatMap`.
 *
 * @example
 * ```ts
 * const current = yield* service.openCounter("c1").pipe(
 *   Rpc.pipeline((counter) => counter.stats.current()),
 * );
 * ```
 */
export const pipeline: {
  <A, B, E2, R2>(
    f: (value: Pending<A>) => Effect.Effect<B, E2, R2>,
  ): <E1, R1>(
    self: Effect.Effect<A, E1, R1>,
  ) => Effect.Effect<B, E1 | E2, Exclude<R1 | R2, Scope.Scope>>;
  <A, E1, R1, B, E2, R2>(
    self: Effect.Effect<A, E1, R1>,
    f: (value: Pending<A>) => Effect.Effect<B, E2, R2>,
  ): Effect.Effect<B, E1 | E2, Exclude<R1 | R2, Scope.Scope>>;
} = dual(2, pipelineImpl);
