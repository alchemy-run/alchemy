import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Budget } from "./Budget.ts";
import type { BudgetExceeded, Refused } from "./Errors.ts";
import type { Halt } from "./Halt.ts";
import type { Services } from "./Services.ts";
import type { Trigger } from "./Trigger.ts";

/**
 * The live handle every interpreted **process term** produces — one
 * shape for the general {@link Process} and its kernel-default
 * specialization `Agent` alike, the only two interpretable kinds (see
 * designs/ai/reports/agent-loop-algebra.md; capability terms and control
 * refs are compiled into their host process, never interpreted).
 *
 * Semantically a process term denotes a **Process**: `In → Run<Out, Err>`, where
 * a Run emits `KernelEvent`s (covariant), accepts steering (contravariant),
 * and completes with `Out` — an Effect `Channel` in denotation, though the
 * public surface deliberately stays these five verbs (the Channel's
 * canonical eliminations), not the seven-parameter algebra:
 *
 * 1. `dispatch` — the Effect view of one run: admit + await the done value.
 * 2. `send` — the admission half of `dispatch` alone (durable, idempotent,
 *    ordered enqueue; no join). The conformance suite asserts the identity
 *    `dispatch = send + await` — if `send` ever grows semantics beyond
 *    admission, there are two protocols again.
 * 3. `run` — the trigger-lift (`effect ∘ serve`): serve the term's
 *    triggers forever. `never` is a theorem (the trigger stream is
 *    unbounded), not a declaration — and on some harnesses "running"
 *    degenerates to "reachable" (a ring compiled to routes + alarms).
 * 4. `steer` — the run's contravariant input: mid-run messages admitted
 *    durably and promoted at the next iteration boundary (never
 *    mid-turn); promotion resets the step allowance. Under
 *    `AI.concurrency > 1` steering needs a run key (the work item's
 *    world identity) — typed in Phase 2.
 * 5. `interrupt` — not part of the channel algebra at all: Scope
 *    authority (§0.6 "authority flows down"), realized as a control
 *    admission through the same inbox. In-flight tool calls settle as
 *    interrupted results (the pairing invariant extends to abandonment),
 *    the fold runs, and a model-visible marker enters the Trace.
 *
 * Identity: a run is keyed by `(term, work item)` — **world identity
 * rides in `In`** (a GitHub issue, a Discord thread). There is no session
 * management API and no durable run object; "a run is active" is
 * derivable from the admission ledger + Trace.
 *
 * All five are runtime verbs, colored with `RuntimeContext`.
 */
export interface ProcessService<Out = void, In = unknown, Err = never> {
  /** Admit one work item and await its run's resolution (admit + join). */
  dispatch(item: In): Effect.Effect<Out, Err, RuntimeContext>;
  /** Admit one work item, fire-and-forget (the admission half alone). */
  send(item: In): Effect.Effect<void, never, RuntimeContext>;
  /** Serve the ring: consume triggers and dispatch runs until interrupted. */
  run(): Effect.Effect<never, Err, RuntimeContext>;
  /** Mid-run input, promoted at the next iteration boundary. */
  steer(input: unknown): Effect.Effect<void, never, RuntimeContext>;
  /** Scope authority: settle in-flight work as interrupted, fold, mark. */
  interrupt(): Effect.Effect<void, never, RuntimeContext>;
}

/**
 * Derives a process's `Out` channel from its halt ref: `AI.until` → `void`
 * (or the declared schema type), `AI.never` → `never`.
 *
 * A charter that wires no halt is typed as perpetual (`Out = never`) — the
 * missing exit signal isn't a constructor error, it makes the process's runs
 * unusable in exactly the right way (`dispatch` returns `Effect<never, …>`,
 * an effect that never resolves), mirroring how `Effect<A, E, R>` carries
 * unsatisfied requirements to the eliminator instead of erroring at
 * construction.
 */
export type ProcessOut<Refs extends any[]> = [
  Extract<Refs[number], Halt<any, any>>,
] extends [never]
  ? never
  : Extract<Refs[number], Halt<any, any>> extends Halt<any, infer Out>
    ? Out
    : never;

/**
 * Derives a process's `In` channel — the union of its triggers' work-item
 * types. `AI.each(issue)` contributes the parameter's schema type,
 * `AI.on(source)` the event schema, `AI.every` contributes `void`.
 *
 * A charter with no trigger refs is dispatch-driven: `In = unknown`
 * (any work item may be admitted), not `never` — a `never` inbox would
 * make `dispatch` uncallable, which is the perpetual treatment and
 * belongs to the halt, not the trigger.
 */
export type ProcessIn<Refs extends any[]> = [
  Extract<Refs[number], Trigger<any, any>>,
] extends [never]
  ? unknown
  : Refs[number] extends infer R
    ? R extends Trigger<infer In, any>
      ? In
      : never
    : never;

/**
 * Derives a process's error channel from its refs:
 *
 * - a `Budget` ref places `BudgetExceeded` in `Err` (ceilings + stall);
 * - a bounded exit (`AI.until` — i.e. `Out` is not `never`) places
 *   `Refused` in `Err`: a run may conclude its goal is unachievable, and
 *   that typed give-up is not a budget exhaustion. Perpetual rings
 *   (`AI.never` or no halt) have nothing to give up on.
 */
export type ProcessErr<Refs extends any[]> =
  | ([Extract<Refs[number], Budget>] extends [never] ? never : BudgetExceeded)
  | ([ProcessOut<Refs>] extends [never] ? never : Refused);

/**
 * A `Process` term is a charter: prose policy whose refs wire trigger,
 * body, halt, fold, and budget. Like all terms it is pure data — behavior
 * comes from interpreters (the Kernel).
 *
 * Process is the **general process term** (`Agent` is its kernel-default
 * specialization — same denotation, control parameters supplied by kernel
 * policy instead of charter refs). Process terms are the only term class
 * the Kernel interprets, each interpretation acquiring a ring of its own.
 * Its control refs (trigger/halt/fold/check/budget) are parameters *of*
 * that ring, not terms with rings of their own.
 *
 * A process is `In → Effect<Out, Err, Req>` lifted over a trigger stream:
 *
 * - `Out` — what a halted run resolves to. Derived from the halt ref:
 *   `AI.until` → `void` (or its schema type); `AI.never` → `never`.
 * - `In` — the work-item shape a run is given. Derived from the triggers.
 * - `Err` — abnormal exits: `BudgetExceeded` when a budget is declared;
 *   `Refused` when the exit is bounded (`AI.until`) — a run may conclude
 *   its goal is unachievable, which is neither success nor exhaustion.
 * - `Req` — the *tags* of the charter's refs (tools, agents, nested
 *   processes, event channels), including refs nested in control-ref
 *   templates. These are the requirements of the process's implementation
 *   Layer; transitive elimination happens by Layer composition
 *   (`AI.layer(Fix).pipe(Layer.provide(AI.layer(Engineer)), …)`).
 * - `Name`, `Refs`, `Self` — term identity, captured by the constructor.
 *
 * Interpolation semantics:
 *
 * - `${Agent}` delegates to it (its tag joins `Req`; the agent's own
 *   tools are requirements of the agent's Layer, not this process's).
 * - `${Process}` nests it — the outer ring may dispatch typed runs of the
 *   inner ring (its tag joins `Req`).
 * - `${AI.observe(Process)}` references its Trace read-only (nothing joins).
 * - `${Tool}` grants the process-level machinery that capability.
 * - Control refs (`AI.on`/`AI.each`/`AI.every`, `AI.until`/`AI.never`,
 *   `AI.check`, `AI.fold`, `AI.budget`, `AI.concurrency`) wire the ring's
 *   semantics. The halt names what ends a run; the check names who judges
 *   it; the fold names who compresses it.
 *
 * Like `Agent`, the `<Self>()` form makes the process a `Context.Service`
 * **tag**: interpolating `${Fix}` in an outer charter contributes the tag
 * `Fix` to the outer process's `Req` (not Fix's transitive tools — those
 * are requirements of *Fix's Layer*). Yielding `Fix` in `Effect.gen`
 * resolves the live `ProcessService<Out, In, Err>` from context;
 * `AI.layer(Fix)` is the kernel-derived default implementation.
 *
 * Capability denial by omission: a charter that never interpolates
 * `${Approve}` has no `Approve` anywhere in its Layer graph's
 * requirements; no Layer can grant it merge authority. Constitutional
 * constraints are enforced by the type system, not by prose.
 */
export interface Process<
  Out = void,
  In = unknown,
  Err = never,
  Req = never,
  Name extends string = string,
  Refs extends any[] = any[],
  Self = unknown,
> {
  "~alchemy/Kind": "Process";
  "~alchemy/Name": Name;
  template: TemplateStringsArray;
  refs: Refs;
  /** Phantom channel carriers. */
  out: Out;
  input: In;
  error: Err;
  /** Phantom: the requirements of this process's implementation Layer. */
  req: Req;
  /**
   * Instances are branded with the process's name so distinct processes
   * remain distinct types (and therefore distinct tags).
   */
  new (
    _: never,
  ): ProcessService<Out, In, Err> & { readonly "~alchemy/Name": Name };
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
}

export const Process: {
  <Self>(): {
    <Name extends string>(
      name: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Process<
        ProcessOut<Refs>,
        ProcessIn<Refs>,
        ProcessErr<Refs>,
        Services<Refs>,
        Name,
        Refs,
        Self
      > &
        Context.Service<
          Self,
          ProcessService<ProcessOut<Refs>, ProcessIn<Refs>, ProcessErr<Refs>>
        >;
    };
  };
  <Name extends string>(
    name: Name,
  ): {
    <const Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Process<
      ProcessOut<Refs>,
      ProcessIn<Refs>,
      ProcessErr<Refs>,
      Services<Refs>,
      Name,
      Refs
    >;
  };
} = ((name?: string) =>
  name
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeProcess(name, template, refs)
    : (name: string) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeProcess(name, template, refs)) as any;

const makeProcess = (
  name: string,
  template: TemplateStringsArray,
  refs: any[],
) =>
  Object.assign(
    class extends (Context.Service<any, ProcessService<any, any, any>>()(
      `alchemy/AI/Process/${name}`,
    ) as any) {},
    {
      "~alchemy/Kind": "Process",
      "~alchemy/Name": name,
      refs,
      template,
    },
  ) as any;

export const isProcess = (
  value: unknown,
): value is Process<any, any, any, any, any, any[], any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Process";
