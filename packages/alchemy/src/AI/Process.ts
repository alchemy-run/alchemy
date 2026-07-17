import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { BudgetExceeded, Refused } from "./Errors.ts";
import type { Services } from "./Services.ts";
import type { Halt, When } from "./Signature.ts";

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
 * 3. `run` — vestigial since auto-delivery was demoted (canon §2:
 *    delivery is always outside code): it joins the ring's unbounded
 *    life. `never` remains a theorem — the ring serves admissions until
 *    its Scope closes.
 * 4. `steer` — the run's contravariant input: mid-run messages admitted
 *    durably and promoted at the next iteration boundary (never
 *    mid-turn); promotion resets the step allowance. Two addressing
 *    forms: `steer(msg)` targets the active run (or parks for the next
 *    turn), `steer(runKey, msg)` targets a SPECIFIC run by its run key
 *    (the session minted at admission, visible on the `run.admitted`
 *    row) — the actor-model `tell` to a running actor. A keyed steer to
 *    a parked machine-exit run wakes it for another work round.
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
  /**
   * Admit one work item and await its run's resolution (admit + join).
   * `options.key` names the run (see {@link ProcessService.send}).
   */
  dispatch(
    item: In,
    options?: { readonly key?: string },
  ): Effect.Effect<Out, Err, RuntimeContext>;
  /**
   * Admit one work item, fire-and-forget (the admission half alone).
   *
   * `options.key` is the run's IMPLEMENTATION-CHOSEN name — the world
   * identity the caller correlates by (`owner/repo#7`), typically the
   * event family's own `EventSource.key`. Naming the run is what makes
   * `steer(key, …)` and `settle(key, …)` addressable from outside code
   * that never saw the kernel-minted session. Unnamed runs remain
   * addressable by the `run.admitted` row's session.
   */
  send(
    item: In,
    options?: { readonly key?: string },
  ): Effect.Effect<void, never, RuntimeContext>;
  /**
   * Join the ring's unbounded life (serves admissions until the Scope
   * closes). Vestigial: auto-delivery is demoted — delivery is always
   * explicit outside code (`send`/`dispatch`/`steer`/`settle`).
   */
  run(): Effect.Effect<never, Err, RuntimeContext>;
  /**
   * Run-key–addressed input: deliver a message to a SPECIFIC run. The
   * run key is the name given at admission (`send(item, { key })`) or
   * the kernel session (the `run.admitted` row). Delivered at the run's
   * next boundary; wakes a parked machine-exit run for another work
   * round.
   */
  steer(
    runKey: string,
    input: unknown,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Mid-run input to the active run, promoted at the next boundary. */
  steer(input: unknown): Effect.Effect<void, never, RuntimeContext>;
  /**
   * Deliver a machine-observed exit to a SPECIFIC run: the run parked on
   * `AI.exit(AI.when(…))` resolves with `event` as its `Out`.
   *
   * Exit delivery is delivery (canon §5: implementations own it): the
   * implementation Layer that received the world's event hands it to the
   * run exactly like a steer — the kernel subscribes to nothing for
   * world-side sources, and correlation IS the key the caller addressed.
   * Settling a key with no parked run is an idempotent no-op (the run
   * may have already settled — the world outranks the org's beliefs).
   */
  settle(
    runKey: string,
    event: unknown,
  ): Effect.Effect<void, never, RuntimeContext>;
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
 * Derives a process's `In` channel — the union of its accepted messages'
 * work-item types: `AI.when(source)` contributes the event schema.
 *
 * A charter with no `when` expressions is dispatch-driven: `In = unknown`
 * (any work item may be admitted), not `never` — a `never` inbox would
 * make `dispatch` uncallable, which is the perpetual treatment and
 * belongs to the halt, not the accepted-message declaration.
 */
export type ProcessIn<Refs extends any[]> = [
  Extract<Refs[number], When<any, any>>,
] extends [never]
  ? unknown
  : Refs[number] extends infer R
    ? R extends When<infer In, any>
      ? In
      : never
    : never;

/**
 * Derives a process's error channel from its refs:
 *
 * - `BudgetExceeded` is UNCONDITIONAL: budgets are provided where the
 *   term is provided (the `AI.budget({...})` Layer, or the kernel's own
 *   default guards when none is given) — the kernel always enforces
 *   some ceiling, so exhaustion is always a typed possibility;
 * - a bounded exit (`AI.until` / `AI.exit` — i.e. `Out` is not `never`)
 *   places `Refused` in `Err`: a run may conclude its goal is
 *   unachievable, and that typed give-up is not a budget exhaustion.
 *   Perpetual rings (`AI.never` or no halt) have nothing to give up on.
 */
export type ProcessErr<Refs extends any[]> =
  | BudgetExceeded
  | ([ProcessOut<Refs>] extends [never] ? never : Refused);

/**
 * A `Process` term is a charter: prose policy whose refs wire the
 * signature (accepted messages, halt), body, fold, and budget. Like all
 * terms it is pure data — behavior comes from interpreters (the Kernel).
 *
 * Process is the **general process term** (`Agent` is its kernel-default
 * specialization — same denotation, control parameters supplied by kernel
 * policy instead of charter refs). Process terms are the only term class
 * the Kernel interprets, each interpretation acquiring a ring of its own.
 * Its signature/control refs (when/halt/fold/check/budget) are
 * parameters *of* that ring, not terms with rings of their own.
 *
 * A process is `In → Effect<Out, Err, Req>` lifted over its inbox:
 *
 * - `Out` — what a halted run resolves to. Derived from the halt ref:
 *   `AI.until` → `void` (or its schema type); `AI.never` → `never`.
 * - `In` — the work-item shape a run is given. Derived from the
 *   accepted-message (`AI.when`) declarations.
 * - `Err` — abnormal exits: `BudgetExceeded` always (some ceiling —
 *   provided Layer or kernel default — is always enforced); `Refused`
 *   when the exit is bounded (`AI.until`/`AI.exit`) — a run may conclude
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
 * - `${Event}` (a bare EventSource mention) grants publication: it joins
 *   the term's `emits`, permits `ctx.emit(Event, payload)`, and places
 *   the source's channel tag in `Req` when channel-backed. The grant is
 *   owner-sensitive (canon §2a ruling 4): a world-owned catalog source
 *   (`GitHub.IssueOpened(repo)`) affords nothing by bare mention — it
 *   renders as vocabulary and grants no publication.
 * - Signature/control refs (`AI.when`, `AI.until`/`AI.exit`/`AI.never`,
 *   `AI.check`, `AI.fold`, `AI.concurrency`) wire the ring's semantics.
 *   The `when` names the accepted messages; the halt names what ends a
 *   run; the check names who judges it; the fold names who compresses it.
 *   (Budgets are NOT charter refs — provide `AI.budget({...})` as a
 *   Layer where the term's implementation is provided.)
 *
 * Like `Agent`, the `<Self>()` form makes the process a `Context.Service`
 * **tag**: interpolating `${Fix}` in an outer charter contributes the tag
 * `Fix` to the outer process's `Req` (not Fix's transitive tools — those
 * are requirements of *Fix's Layer*). Yielding `Fix` in `Effect.gen`
 * resolves the live `ProcessService<Out, In, Err>` from context;
 * `AI.layer(Fix)` is the kernel-derived default implementation.
 *
 * **The declared interface** (`AI.Process<Self, Interface>()`): a process
 * may declare domain operations *on top of* the actor verbs — the service
 * shape its tag resolves to becomes `ProcessService<Out, In, Err> &
 * Interface`. Declaring an interface obligates the implementation to
 * supply those methods: `AI.layer(Term, (inner) => ({ …domain }))` is the
 * lightweight form (the kernel interprets the charter, your `make` adds
 * the domain methods over the verbs — omitting it is an arity error);
 * `Layer.effect(Term, …)` remains the full-control form (interpret via
 * `AI.Kernel` yourself, wrap ingestion, return the complete service).
 * The default `{}` keeps every plain term exactly as before.
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
  Iface = {},
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
   * remain distinct types (and therefore distinct tags). The declared
   * interface (if any) rides the instance shape alongside the verbs.
   */
  new (
    _: never,
  ): ProcessService<Out, In, Err> & Iface & { readonly "~alchemy/Name": Name };
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
}

// ─── kinds: user-defined Process specializations (org-chat §2.5) ─────
//
// A kind is a MACRO plus METADATA — never kernel knowledge, never an
// embedded implementation. It lowers to a plain Process term: the
// kind's charter scaffolding is spliced around each instance's prose
// by template composition (templates are data), and the instance
// carries `~alchemy/Subkind` + the kind's `meta` for topology/UI.
// `InterpretableTerm` stays `Agent | Process`; the tag resolves to
// plain `ProcessService`.

/** The splice marker: where an instance's prose lands in the scaffold. */
export interface CharterBody {
  "~alchemy/Kind": "CharterBody";
}
export const body: CharterBody = { "~alchemy/Kind": "CharterBody" };

/** A captured scaffold template (`AI.charter\`…${AI.body}…\``). */
export interface Charter<Refs extends any[] = any[]> {
  "~alchemy/Kind": "Charter";
  strings: ReadonlyArray<string>;
  refs: Refs;
}

export const charter = <const Refs extends any[]>(
  strings: TemplateStringsArray,
  ...refs: Refs
): Charter<Refs> => ({
  "~alchemy/Kind": "Charter",
  strings: [...strings],
  refs,
});

const isCharterBody = (ref: unknown): ref is CharterBody =>
  typeof ref === "object" &&
  ref !== null &&
  (ref as Record<string, unknown>)["~alchemy/Kind"] === "CharterBody";

/**
 * Splice an instance's template into a scaffold at its `${AI.body}`
 * marker. Pure data surgery: strings concatenate at the seam, refs
 * interleave. The scaffold's refs around the body — accepted messages,
 * halts, budgets, standard tools — are constitutional: instances cannot
 * remove them, only add their own.
 */
export const spliceCharter = (
  scaffold: Charter,
  instance: { strings: ReadonlyArray<string>; refs: ReadonlyArray<unknown> },
): { strings: ReadonlyArray<string>; refs: ReadonlyArray<unknown> } => {
  const at = scaffold.refs.findIndex(isCharterBody);
  if (at === -1) {
    throw new Error(
      "kind charter has no ${AI.body} splice point — the scaffold must say where instance prose lands",
    );
  }
  const strings =
    instance.refs.length === 0
      ? [
          ...scaffold.strings.slice(0, at),
          // no instance refs: the body collapses into ONE seam string
          (scaffold.strings[at] ?? "") +
            (instance.strings[0] ?? "") +
            (scaffold.strings[at + 1] ?? ""),
          ...scaffold.strings.slice(at + 2),
        ]
      : [
          ...scaffold.strings.slice(0, at),
          (scaffold.strings[at] ?? "") + (instance.strings[0] ?? ""),
          ...instance.strings.slice(1, -1),
          (instance.strings[instance.strings.length - 1] ?? "") +
            (scaffold.strings[at + 1] ?? ""),
          ...scaffold.strings.slice(at + 2),
        ];
  const refs = [
    ...scaffold.refs.slice(0, at),
    ...instance.refs,
    ...scaffold.refs.slice(at + 1),
  ];
  return { strings, refs };
};

/** A kind's definition: the macro and the app-facing metadata. */
export interface ProcessKindDefinition<
  ScaffoldRefs extends any[] = any[],
  Meta = unknown,
> {
  /**
   * The scaffold spliced around each instance's template. Receives the
   * instance name; must contain exactly one `${AI.body}`.
   */
  readonly charter: (name: string) => Charter<ScaffoldRefs>;
  /**
   * User-defined, JSON-ish. Flows through `AI.topology` and the
   * serving tier to the app untouched — the "integrate with my app"
   * hook (icon, category, ordering…).
   */
  readonly meta?: Meta;
}

/** The constructor a kind returns — same dual shape as `AI.Process`. */
export interface ProcessKind<
  KindName extends string = string,
  ScaffoldRefs extends any[] = any[],
  Meta = unknown,
> {
  "~alchemy/Kind": "ProcessKind";
  "~alchemy/Name": KindName;
  readonly definition: ProcessKindDefinition<ScaffoldRefs, Meta>;
  <Self>(): {
    <Name extends string>(
      name: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Process<
        ProcessOut<[...ScaffoldRefs, ...Refs]>,
        ProcessIn<[...ScaffoldRefs, ...Refs]>,
        ProcessErr<[...ScaffoldRefs, ...Refs]>,
        Services<[...ScaffoldRefs, ...Refs]>,
        Name,
        [...ScaffoldRefs, ...Refs],
        Self
      > &
        Context.Service<
          Self,
          ProcessService<
            ProcessOut<[...ScaffoldRefs, ...Refs]>,
            ProcessIn<[...ScaffoldRefs, ...Refs]>,
            ProcessErr<[...ScaffoldRefs, ...Refs]>
          >
        >;
    };
  };
}

export const Process: {
  // ── the kind form: AI.Process(name, definition) ────────────────
  <
    KindName extends string,
    const ScaffoldRefs extends any[],
    const Meta = unknown,
  >(
    name: KindName,
    definition: ProcessKindDefinition<ScaffoldRefs, Meta>,
  ): ProcessKind<KindName, ScaffoldRefs, Meta>;
  // ── the instance forms (the base constructor is the trivial kind) ──
  //
  // `Interface` (optional) declares the domain operations the term's tag
  // resolves to ON TOP OF the actor verbs: the Context.Service shape
  // becomes `ProcessService<Out, In, Err> & Interface`. A term that
  // declares one must be implemented with the methods supplied —
  // `AI.layer(Term, (inner) => ({ …domain }))` (the `make` argument
  // becomes required) or a hand-written `Layer.effect(Term, …)`.
  <Self, Interface = {}>(): {
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
        Self,
        Interface
      > &
        Context.Service<
          Self,
          ProcessService<ProcessOut<Refs>, ProcessIn<Refs>, ProcessErr<Refs>> &
            Interface
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
} = ((name?: string, definition?: ProcessKindDefinition) => {
  if (name !== undefined && definition !== undefined) {
    return makeProcessKind(name, definition);
  }
  return name
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeProcess(name, template, refs)
    : (name: string) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeProcess(name, template, refs);
}) as any;

const makeProcess = (
  name: string,
  template: TemplateStringsArray | ReadonlyArray<string>,
  refs: any[],
  branding?: { subkind: string; meta: unknown },
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
      ...(branding !== undefined && {
        "~alchemy/Subkind": branding.subkind,
        "~alchemy/Meta": branding.meta,
      }),
    },
  ) as any;

const makeProcessKind = (
  kindName: string,
  definition: ProcessKindDefinition,
): any =>
  Object.assign(
    // the kind is itself a constructor with the <Self>() dual shape
    () =>
      (name: string) =>
      (template: TemplateStringsArray, ...refs: any[]) => {
        const scaffold = definition.charter(name);
        const composed = spliceCharter(scaffold, {
          strings: [...template],
          refs,
        });
        return makeProcess(name, composed.strings, [...composed.refs], {
          subkind: kindName,
          meta: definition.meta,
        });
      },
    {
      "~alchemy/Kind": "ProcessKind",
      "~alchemy/Name": kindName,
      definition,
    },
  );

export const isProcess = (
  value: unknown,
): value is Process<any, any, any, any, any, any[], any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Process";
