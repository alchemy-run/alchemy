import * as Context from "effect/Context";
import type { Budget } from "./Budget.ts";
import type { BudgetExceeded, Refused } from "./Errors.ts";
import type { Halt } from "./Halt.ts";
import type { ProcessService } from "./Process.ts";
import type { LoopServices } from "./Services.ts";
import type { Trigger } from "./Trigger.ts";

/**
 * Derives a loop's `Out` channel from its halt ref: `AI.until` → `void`
 * (or the declared schema type), `AI.never` → `never`.
 *
 * A charter that wires no halt is typed as perpetual (`Out = never`) — the
 * missing exit signal isn't a constructor error, it makes the loop's runs
 * unusable in exactly the right way (`dispatch` returns `Effect<never, …>`,
 * an effect that never resolves), mirroring how `Effect<A, E, R>` carries
 * unsatisfied requirements to the eliminator instead of erroring at
 * construction.
 */
export type LoopOut<Refs extends any[]> = [
  Extract<Refs[number], Halt<any, any>>,
] extends [never]
  ? never
  : Extract<Refs[number], Halt<any, any>> extends Halt<any, infer Out>
    ? Out
    : never;

/**
 * Derives a loop's `In` channel — the union of its triggers' work-item
 * types. `AI.each(issue)` contributes the parameter's schema type,
 * `AI.on(source)` the event schema, `AI.every` contributes `void`.
 */
export type LoopIn<Refs extends any[]> = Refs[number] extends infer R
  ? R extends Trigger<infer In, any>
    ? In
    : never
  : never;

/**
 * Derives a loop's error channel from its refs:
 *
 * - a `Budget` ref places `BudgetExceeded` in `Err` (ceilings + stall);
 * - a bounded exit (`AI.until` — i.e. `Out` is not `never`) places
 *   `Refused` in `Err`: a run may conclude its goal is unachievable, and
 *   that typed give-up is not a budget exhaustion. Perpetual rings
 *   (`AI.never` or no halt) have nothing to give up on.
 */
export type LoopErr<Refs extends any[]> =
  | ([Extract<Refs[number], Budget>] extends [never] ? never : BudgetExceeded)
  | ([LoopOut<Refs>] extends [never] ? never : Refused);

/**
 * The live handle a `Loop` term interprets into — a {@link ProcessService}
 * whose channels are derived from the charter's refs.
 *
 * `Out` is run-scoped: a *run* is the loop applied to one work item, and
 * `dispatch` resolves with the run's result when the halt condition is met.
 * The *ring* — the stream of runs serving triggers — never resolves (two
 * different `never`s: `run()`'s is structural, the perpetual charter's
 * `Out = never` is declared).
 */
export interface LoopService<
  Out = void,
  In = unknown,
  Err = never,
> extends ProcessService<Out, In, Err> {}

/**
 * A `Loop` term is a charter: prose policy whose refs wire trigger, body,
 * halt, fold, and budget. Like all terms it is pure data — behavior comes
 * from interpreters (the Kernel).
 *
 * Loop is one of the two **process terms** (with {@link Agent} — the
 * `InterpretableTerm` union): the only term class the Kernel interprets,
 * each interpretation acquiring a ring of its own. Its control refs
 * (trigger/halt/fold/check/budget) are parameters *of* that ring, not
 * terms with rings of their own.
 *
 * A loop is `In → Effect<Out, Err, Req>` lifted over a trigger stream:
 *
 * - `Out` — what a halted run resolves to. Derived from the halt ref:
 *   `AI.until` → `void` (or its schema type); `AI.never` → `never`.
 * - `In` — the work-item shape a run is given. Derived from the triggers.
 * - `Err` — abnormal exits: `BudgetExceeded` when a budget is declared;
 *   `Refused` when the exit is bounded (`AI.until`) — a run may conclude
 *   its goal is unachievable, which is neither success nor exhaustion.
 * - `Req` — the *tags* of the charter's refs (tools, agents, nested
 *   loops, event channels), including refs nested in control-ref
 *   templates. These are the requirements of the loop's implementation
 *   Layer; transitive elimination happens by Layer composition
 *   (`AI.layer(Fix).pipe(Layer.provide(AI.layer(Engineer)), …)`).
 * - `Name`, `Refs`, `Self` — term identity, captured by the constructor.
 *
 * Interpolation semantics:
 *
 * - `${Agent}` delegates to it (its tag joins `Req`; the agent's own
 *   tools are requirements of the agent's Layer, not this loop's).
 * - `${Loop}` nests it — the outer ring may dispatch typed runs of the
 *   inner ring (its tag joins `Req`).
 * - `${AI.observe(Loop)}` references its Trace read-only (nothing joins).
 * - `${Tool}` grants the loop-level machinery that capability.
 * - Control refs (`AI.on`/`AI.each`/`AI.every`, `AI.until`/`AI.never`,
 *   `AI.check`, `AI.fold`, `AI.budget`, `AI.concurrency`) wire the ring's
 *   semantics. The halt names what ends a run; the check names who judges
 *   it; the fold names who compresses it.
 *
 * Like `Agent`, the `<Self>()` form makes the loop a `Context.Service`
 * **tag**: interpolating `${Fix}` in an outer charter contributes the tag
 * `Fix` to the outer loop's `Req` (not Fix's transitive tools — those are
 * requirements of *Fix's Layer*). Yielding `Fix` in `Effect.gen` resolves
 * the live `LoopService<Out, In, Err>` from context; `AI.layer(Fix)` is
 * the kernel-derived default implementation.
 *
 * Capability denial by omission: a charter that never interpolates
 * `${Approve}` has no `Approve` anywhere in its Layer graph's
 * requirements; no Layer can grant it merge authority. Constitutional
 * constraints are enforced by the type system, not by prose.
 */
export interface Loop<
  Out = void,
  In = unknown,
  Err = never,
  Req = never,
  Name extends string = string,
  Refs extends any[] = any[],
  Self = unknown,
> {
  "~alchemy/Kind": "Loop";
  "~alchemy/Name": Name;
  template: TemplateStringsArray;
  refs: Refs;
  /** Phantom channel carriers. */
  out: Out;
  input: In;
  error: Err;
  /** Phantom: the requirements of this loop's implementation Layer. */
  req: Req;
  /**
   * Instances are branded with the loop's name so distinct loops remain
   * distinct types (and therefore distinct tags).
   */
  new (
    _: never,
  ): LoopService<Out, In, Err> & { readonly "~alchemy/Name": Name };
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
}

export const Loop: {
  <Self>(): {
    <Name extends string>(
      name: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Loop<
        LoopOut<Refs>,
        LoopIn<Refs>,
        LoopErr<Refs>,
        LoopServices<Refs>,
        Name,
        Refs,
        Self
      > &
        Context.Service<
          Self,
          LoopService<LoopOut<Refs>, LoopIn<Refs>, LoopErr<Refs>>
        >;
    };
  };
  <Name extends string>(
    name: Name,
  ): {
    <const Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Loop<
      LoopOut<Refs>,
      LoopIn<Refs>,
      LoopErr<Refs>,
      LoopServices<Refs>,
      Name,
      Refs
    >;
  };
} = ((name?: string) =>
  name
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeLoop(name, template, refs)
    : (name: string) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeLoop(name, template, refs)) as any;

const makeLoop = (name: string, template: TemplateStringsArray, refs: any[]) =>
  Object.assign(
    class extends (Context.Service<any, LoopService<any, any, any>>()(
      `alchemy/AI/Loop/${name}`,
    ) as any) {},
    {
      "~alchemy/Kind": "Loop",
      "~alchemy/Name": name,
      refs,
      template,
    },
  ) as any;

export const isLoop = (value: unknown): value is Loop =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Loop";
