import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Pipeable } from "effect/Pipeable";
import { toFqn } from "./FQN.ts";
import type { Input } from "./Input.ts";
import { CurrentNamespace, type NamespaceNode } from "./Namespace.ts";
import * as Output from "./Output.ts";
import { Stack } from "./Stack.ts";

/**
 * A Task is a node in the dependency graph that runs an Effect with its
 * resolved input during {@link plan}/{@link apply}. It is similar to a
 * Resource but without a Provider lifecycle:
 *
 *   - It has a LogicalId and typed Input.
 *   - The body Effect is called when input changes (diff) or `--force` is set.
 *   - There is no replace/precreate/read/delete: removing a Task from the
 *     stack simply drops its persisted state without invoking the body.
 *   - The Effect's `Req` channel bubbles up to the call site, exactly like
 *     a Resource's provider services.
 *
 * Tasks are recorded on {@link Stack.tasks} and produce a single `output`
 * value that downstream Resources / Tasks consume as `Output<T>`.
 */
export interface TaskLike<
  Type extends string = string,
  In extends object | undefined = any,
  Out = any,
> {
  readonly Kind: "task";
  readonly Namespace: NamespaceNode | undefined;
  readonly FQN: string;
  readonly Type: Type;
  readonly LogicalId: string;
  readonly Input: In;
  /** Implementation invoked when input changes. Receives the resolved input. */
  readonly Run: (input: In) => Effect.Effect<Out, any, any>;
  /** @internal phantom */
  Output: Out;
}

export const isTask = (value: any): value is TaskLike =>
  typeof value === "object" && value !== null && value?.Kind === "task";

/** Registered task instance. `output` is an `Output<Out>` for downstream use. */
export type Task<
  Type extends string = string,
  In extends object | undefined = any,
  Out = any,
> = Pipeable &
  TaskLike<Type, In, Out> & {
    readonly output: Output.Output<Out, never>;
  };

export type TaskRunner<In extends object | undefined, Out, Req> = (
  input: In,
) => Effect.Effect<Out, any, Req>;

// ── Public API ─────────────────────────────────────────────────────────────
//
// Inline (impl baked in at definition time):
//
//   const Sync = Task("Sync", Effect.fn(function* (input: { table: string }) {
//     return { rows: 42 };
//   }));
//
//   const sync = yield* Sync({ table: bucket.name });
//   // or with an explicit logical id for multiple instances:
//   const nightly = yield* Sync("nightly", { table: bucket.name });
//
// Tagged (impl supplied separately via Layer):
//
//   class Sync extends Task<Sync, { table: string }, { rows: number }>()("Sync") {}
//   const SyncLive = Sync.make(Effect.fn(function* (input) { ... }));
//
//   // In a stack:
//   const sync = yield* Sync({ table: bucket.name });
//   //         ^ requires `Sync` — satisfied by adding SyncLive to providers.

export function Task<
  Type extends string,
  In extends object | undefined,
  Out,
  Req = never,
>(
  type: Type,
  run: TaskRunner<In, Out, Req>,
): TaskClass<never, Type, In, Out, Req>;

export function Task<Self, In extends object | undefined, Out>(): <
  Type extends string,
>(
  type: Type,
) => TaskClass<Self, Type, In, Out, Self>;

export function Task(...args: any[]): any {
  if (args.length === 0) {
    // Tagged form: Task<Self, In, Out>()(type)
    return (type: string) => makeTaskClass(type, undefined);
  }
  // Inline form: Task(type, run)
  const [type, run] = args as [string, TaskRunner<any, any, any>];
  return makeTaskClass(type, run);
}

export interface TaskClass<
  Self,
  Type extends string,
  In extends object | undefined,
  Out,
  Req,
> {
  readonly Type: Type;
  /**
   * Default form — uses `Type` as the LogicalId. One instance per Task
   * definition (the common case for deploy-time work).
   */
  (input: { [k in keyof In]: Input<In[k]> }): Effect.Effect<
    Task<Type, In, Out>,
    never,
    Req | Stack
  >;
  /**
   * Explicit-id form — register multiple instances of the same Task
   * definition under distinct logical ids.
   */
  (
    id: string,
    input: { [k in keyof In]: Input<In[k]> },
  ): Effect.Effect<Task<Type, In, Out>, never, Req | Stack>;
  /**
   * Tagged-only: bind an implementation to this Task's Self tag. Add the
   * returned Layer to the stack's `providers`.
   */
  make: [Self] extends [never]
    ? never
    : <R = never>(run: TaskRunner<In, Out, R>) => Layer.Layer<Self, never, R>;
  /** Tagged-only: the Context tag holding the runner. */
  readonly Self: [Self] extends [never]
    ? never
    : Context.Service<Self, TaskRunner<In, Out, any>>;
}

const makeTaskClass = (
  type: string,
  bakedRunner: TaskRunner<any, any, any> | undefined,
): any => {
  // Tagged form needs a Context tag so the user can supply the runner
  // through a Layer. Inline form bakes the runner in and skips the tag.
  const SelfTag = bakedRunner
    ? undefined
    : Context.Service<any, TaskRunner<any, any, any>>(`alchemy/Task<${type}>`);

  const constructor = (...args: [any] | [string, any]) => {
    const [id, input] =
      args.length === 1 ? [type, args[0]] : (args as [string, any]);
    return Effect.gen(function* () {
      const run =
        bakedRunner ?? ((yield* SelfTag!) as TaskRunner<any, any, any>);
      return yield* registerTask(type, id, input, run);
    });
  };

  const extra: Record<string, any> = { Type: type };
  if (SelfTag) {
    extra.Self = SelfTag;
    extra.make = <R>(run: TaskRunner<any, any, R>) =>
      Layer.succeed(SelfTag, run as TaskRunner<any, any, any>);
  }
  return Object.assign(constructor, extra);
};

const registerTask = <Type extends string, In extends object | undefined, Out>(
  type: Type,
  id: string,
  input: any,
  run: TaskRunner<In, Out, any>,
): Effect.Effect<Task<Type, In, Out>, never, Stack> =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const namespace = yield* CurrentNamespace;
    const fqn = toFqn(namespace, id);

    const tasks = (stack.tasks ??= {});
    const existing = tasks[fqn];
    if (existing) return existing as Task<Type, In, Out>;

    // FQN collision check: tasks share the same FQN namespace as resources
    // so the dependency graph stays unified. Rejecting overlaps here makes
    // the constraint obvious at registration time.
    if (stack.resources[fqn]) {
      return yield* Effect.die(
        new Error(
          `Task '${fqn}' collides with a Resource of the same logical id`,
        ),
      );
    }

    const target: any = {
      Kind: "task" as const,
      Type: type,
      Namespace: namespace,
      FQN: fqn,
      LogicalId: id,
      Input: input,
      Run: run,
      toString() {
        return `Task<${type}>(${id})`;
      },
      [Symbol.toPrimitive](hint: string) {
        return hint === "number" ? NaN : target.toString();
      },
    };

    // Wrap in a Proxy so `task.output` resolves to an `Output<Out>`. The
    // engine writes the materialized value into `tracker[fqn]`; Output
    // evaluation resolves a ResourceExpr by looking up `outputs[fqn]`.
    // Property access into `task.output.foo` chains through the standard
    // PropExpr proxy that ResourceExpr supplies.
    const task: Task<Type, In, Out> = new Proxy(target, {
      get: (t, prop) => {
        if (typeof prop === "symbol" || prop in t) {
          return t[prop as keyof typeof t];
        }
        if (prop === "output") {
          return Output.of(task as any);
        }
        return undefined;
      },
    });

    tasks[fqn] = task as any;
    return task;
  });
