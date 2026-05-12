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
 * resolved inputs during {@link plan}/{@link apply}. It is similar to a
 * Resource but without a Provider lifecycle:
 *
 *   - It has a LogicalId and typed Input.
 *   - The implementation Effect is called when inputs change (diff) or when
 *     `--force` is passed.
 *   - There is no replace/precreate/read/delete lifecycle: removing a Task
 *     from the stack simply drops its persisted state without invoking it.
 *   - The Effect's `Req` channel bubbles up to the constructor, exactly like
 *     a Resource's provider services.
 *
 * Tasks are recorded on {@link Stack.tasks} and produce a single `output`
 * value that downstream Resources / Tasks can consume as `Output<T>`.
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
  /**
   * The implementation Effect to run when inputs change. Receives the
   * resolved input value.
   */
  readonly Run: (input: In) => Effect.Effect<Out, any, any>;
  /** @internal phantom */
  Output: Out;
}

export const isTask = (value: any): value is TaskLike =>
  typeof value === "object" && value !== null && value?.Kind === "task";

/**
 * A registered Task instance. Acts as a node in the Output graph: its
 * `output` field is an {@link Output.Output} that resolves to the Effect's
 * return value once the Task has run.
 */
export type Task<
  Type extends string = string,
  In extends object | undefined = any,
  Out = any,
> = Pipeable &
  TaskLike<Type, In, Out> & {
    /**
     * The value produced by running this Task. Usable as `Output<T>` in
     * downstream resource inputs and other tasks. Property access chains
     * through the standard Output proxy (`sync.output.rows` is
     * `Output<number>`).
     */
    readonly output: Output.Output<Out, never>;
  };

export type TaskRunner<In extends object | undefined, Out, Req> = (
  input: In,
) => Effect.Effect<Out, any, Req>;

// ── Inline form ────────────────────────────────────────────────────────────
//
//   const sync = yield* Task("nightly-sync", { table: bucket.name },
//     Effect.fn(function* (input) {
//       // input: { table: string }
//       return { rows: 42 };
//     }),
//   );
//   sync.output // Output<{ rows: number }>
//
// The implementation Effect receives the *resolved* input. Its `Req` channel
// is propagated to the constructor's call site.

export function Task<In extends object | undefined, Out, Req = never>(
  id: string,
  input: { [k in keyof In]: Input<In[k]> },
  run: TaskRunner<In, Out, Req>,
): Effect.Effect<Task<string, In, Out>, never, Req | Stack>;

// ── Tagged (service + layer) form ──────────────────────────────────────────
//
//   export class NightlySync extends Task<NightlySync, { table: string }, { rows: number }>()("NightlySync") {}
//
//   export const NightlySyncLive = NightlySync.make(
//     Effect.fn(function* (input) { return { rows: 42 } }),
//   );
//
//   // In a stack:
//   const sync = yield* NightlySync("nightly", { table: "users" });
//   //         ^ Effect.Effect<Task<...>, never, NightlySync>
//
// `NightlySyncLive` is a Layer that resolves the tag to the runner. Provide
// it via the stack's `providers` so the constructor's `Req = NightlySync` is
// satisfied.

export function Task<Self, In extends object | undefined, Out>(): <
  Type extends string,
>(
  type: Type,
) => TaskClass<Self, Type, In, Out>;

export function Task(...args: any[]): any {
  if (args.length === 0) {
    // Tagged form: Task<Self, In, Out>()(type)
    return (type: string) => makeTaskClass<any, string, any, any>(type);
  }
  // Inline form: Task(id, input, run)
  const [id, input, run] = args as [string, any, TaskRunner<any, any, any>];
  return registerTask<string, any, any>("alchemy/Task", id, input, run);
}

// ── Tagged class ──────────────────────────────────────────────────────────

export interface TaskClass<
  Self,
  Type extends string,
  In extends object | undefined,
  Out,
> {
  readonly Type: Type;
  /** Context service tag holding the runner. Satisfied by {@link TaskClass.make}. */
  readonly Self: Context.Service<Self, TaskRunner<In, Out, any>>;
  /** Register a Task instance on the current Stack. */
  (
    id: string,
    input: { [k in keyof In]: Input<In[k]> },
  ): Effect.Effect<Task<Type, In, Out>, never, Self | Stack>;
  /**
   * Bind an implementation to this Task tag. Returns a Layer suitable for
   * the stack's `providers`.
   */
  make<Req = never>(
    run: TaskRunner<In, Out, Req>,
  ): Layer.Layer<Self, never, Exclude<Req, never>>;
}

const makeTaskClass = <
  Self,
  Type extends string,
  In extends object | undefined,
  Out,
>(
  type: Type,
): TaskClass<Self, Type, In, Out> => {
  // Per-class tag. The tag identity is keyed by the user-supplied type name
  // so two `make(...)` Layers for the same Task type collide — which is the
  // desired behavior, since two distinct runners for one Task is undefined.
  const SelfTag = Context.Service<Self, TaskRunner<In, Out, any>>(
    `alchemy/Task<${type}>`,
  );

  function constructor(id: string, input: any) {
    return Effect.gen(function* () {
      const run = (yield* SelfTag) as TaskRunner<In, Out, any>;
      return yield* registerTask<Type, In, Out>(type, id, input, run);
    });
  }

  const make = <Req>(run: TaskRunner<In, Out, Req>) =>
    Layer.succeed(SelfTag, run as TaskRunner<In, Out, any>);

  return Object.assign(constructor as any, {
    Type: type,
    Self: SelfTag,
    make,
  }) as TaskClass<Self, Type, In, Out>;
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

    // Wrap in a Proxy so `task.output` resolves to an `Output<Out>` pointing
    // at the eventual return value of `Run`. The engine writes the
    // materialized value into `tracker[fqn].output`; `Output.evaluate`
    // resolves a ResourceExpr by looking up `outputs[fqn]` — which is
    // precisely that materialized value. Property access into
    // `task.output.foo` chains through the standard PropExpr proxy that
    // ResourceExpr already supplies.
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
