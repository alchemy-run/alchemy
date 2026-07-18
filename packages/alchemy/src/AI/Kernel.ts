import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { Agent, AgentService } from "./Agent.ts";
import type { KernelError } from "./Errors.ts";
import type { Process, ProcessService } from "./Process.ts";
import type { ProcessContext } from "./ProcessContext.ts";

/**
 * A single entry in the Trace — the persisted event stream that is the
 * single representation used by folds (memory), durability (journal /
 * replay), observability (OTel export), and the system loop (autoresearch
 * input).
 *
 * Schema discipline (learned at others' expense, §9.3):
 *
 * - **Versioned from v1.** Durable payloads change; unversioned events
 *   forced OpenCode to reset history twice. `v` is the schema version.
 * - **Deterministic identity.** Durability-relevant events derive `id`
 *   from `(term, session, turn, callId/ordinal)` — never minted at emit
 *   time — so replay collides idempotently instead of duplicating.
 * - **Durable vs live is a type-level split.** Streaming deltas
 *   (`durable: false`) can never advance a trace cursor, never replay,
 *   and are excluded from folds. Only durable events carry `seq`.
 * - **Cause and auth ride every event.** `cause` is the parent command /
 *   stimulus that produced this event (a seam without provenance rots
 *   — pi #5217); `auth` distinguishes human-initiated from ring-initiated
 *   work so approval policies and budgets can be caller-sensitive.
 */
export interface KernelEvent {
  /** Event schema version. */
  readonly v: 1;
  readonly type: string;
  /** Deterministic id for durable events (replay-idempotent). */
  readonly id: string;
  /** Whether this event persists to the Trace (deltas are live-only). */
  readonly durable: boolean;
  /** Per-ring sequence — the only durable cursor. Absent on live events. */
  readonly seq?: number;
  /** The ring path, outermost first (e.g. `["Flywheel", "Fix"]`). */
  readonly ring: ReadonlyArray<string>;
  /** Content hash of the rendered term that produced this event. */
  readonly term?: string;
  readonly session?: string;
  /** The parent command id / stimulus that caused this event. */
  readonly cause?: string;
  /** Caller provenance: who created the session vs who caused this turn. */
  readonly auth?: { readonly initiator: string; readonly current: string };
  readonly payload?: unknown;
}

/**
 * The Kernel is the interpreter of **process terms** (Agent | Process) —
 * one `Context.Service` with a deliberately small surface. Note the
 * vocabulary that is absent: memory, compaction, context, sandbox,
 * session-store, sub-agent, model. Those exist only as services that
 * particular Kernel *implementations* pull from their own requirements
 * (seams), invisible to this interface.
 *
 * Interpreting a process term resolves the term's ref tags **from the
 * ambient context** — which is why `interpret` carries the term's `Req`
 * in its requirement channel: `kernel.interpret(Engineer)` can only run
 * where Engineer's tools are provided. `AI.layer` packages exactly this
 * into a per-term Layer.
 *
 * Two event surfaces, two contracts (§9.3 — never unified):
 *
 * - `events` — the live firehose: includes non-durable deltas, offers no
 *   replay guarantee, may drop on disconnect. For dev UIs and dashboards.
 * - `trace` — the durable log of one ring: replay from a cursor, then
 *   tail live commits. Rows are truth, wakes are hints. This is what
 *   folds consume and what `AI.observe` grants access to — observation
 *   is a pure storage read that neither wakes the ring nor resets any
 *   keepalive.
 */
/**
 * The **process terms** — the only term class the Kernel interprets
 * (design §1 taxonomy). Agent and Process denote the same object — a
 * Process `In → Run<Out, Err>` (see
 * designs/ai/reports/agent-loop-algebra.md); they differ only in *who
 * supplies the control parameters* (kernel defaults vs charter refs),
 * so interpretation is one method, not two.
 *
 * The other term classes never appear here: capability terms
 * (`Tool`/`Parameter`) are compiled *into* their host process's turn
 * (toolkit schema + handler resolved from context), and signature/control
 * refs (`When`/`Halt`/`Fold`/`Check`/`Budget`/`Concurrency`/`Observe`)
 * parameterize the host's ring. Neither has runs, an inbox, or a ring
 * of its own.
 */
export type InterpretableTerm =
  | Agent<any, any[], any, any>
  | Process<any, any, any, any, any, any[], any, any>;

/** The service an interpreted process term produces. */
export type TermService<T> =
  T extends Process<infer Out, infer In, infer Err, any, any, any[], any, any>
    ? ProcessService<Out, In, Err>
    : T extends Agent<any, any[], any, any>
      ? AgentService
      : never;

/** The term's construction requirements (its refs' tags). */
export type TermReq<T> =
  T extends Process<any, any, any, infer Req, any, any[], any, any>
    ? Req
    : T extends Agent<any, any[], any, infer Req>
      ? Req
      : never;

export interface KernelService {
  /**
   * Interpret a process term into its live service, resolving the
   * term's ref tags from the ambient context (which is why the term's
   * `Req` rides the requirement channel).
   *
   * Interpretation is **scoped**: it acquires the term's ring — the
   * single serial loop that drains the term's admission mailbox — whose
   * lifetime is the Scope's. `AI.layer` discharges the Scope into the
   * Layer's lifetime, so a term's ring lives exactly as long as its
   * Layer is provided.
   */
  readonly interpret: <T extends InterpretableTerm>(
    term: T,
  ) => Effect.Effect<TermService<T>, KernelError, TermReq<T> | Scope.Scope>;
  /**
   * Interpret a process term with a **deterministic handler** instead
   * of a model loop (reassess §C): the handler `(item, ctx) => Effect<
   * Out, Err>` becomes the ring's per-work-item work. Same ring
   * machinery as `interpret` — mailbox, dispatch = send + await,
   * steer, interrupt, `run.admitted`/`run.settled` — so a
   * hand-written coordinator is a first-class process. The handler's
   * own requirements are provided by the process's Layer (like a
   * term's tool tags); `AI.process(term, handler)` packages this.
   */
  readonly process: <Out, In, Err>(
    term: Process<Out, In, Err, any, any, any[], any, any>,
    handler: (item: In, ctx: ProcessContext) => Effect.Effect<Out, Err, never>,
  ) => Effect.Effect<ProcessService<Out, In, Err>, KernelError, Scope.Scope>;
  /** Live firehose: all interpreted process terms' events, deltas included. */
  readonly events: Stream.Stream<KernelEvent>;
  /** Durable replay-then-tail over one ring's Trace, from a cursor. */
  readonly trace: (
    ring: string,
    after?: number,
  ) => Stream.Stream<KernelEvent, KernelError>;
}

export class Kernel extends Context.Service<Kernel, KernelService>()(
  "alchemy/AI/Kernel",
) {}

/**
 * The domain shape of a process term's tag — `{}` (no keys) for a plain
 * term (whose tag IS the actor verbs), the declared interface for an
 * interface-bearing term (whose tag is SEALED to it). Verb-named keys
 * are reserved: `AI.layer`/`AI.process`'s lightweight `make` form can't
 * re-expose `send`/`steer`/… under their own names — use the
 * full-control `Layer.effect(Term, …)` form for that.
 */
export type ProcessDomain<Shape> = Omit<
  Shape,
  keyof ProcessService<any, any, any>
>;

/** The verbs half of a term's service — what interpretation yields. */
type ProcessVerbsOf<L> =
  L extends Process<infer Out, infer In, infer Err, any, any, any[], any, any>
    ? ProcessService<Out, In, Err>
    : never;

/**
 * The conditionally-required `make` argument of the kernel-default
 * Layers (`AI.layer`, `AI.process`): a plain term takes no extra
 * argument; an interface-bearing term REQUIRES a function that builds
 * its domain methods over the interpreted verbs (omitting it is an
 * ordinary arity error). `make` may return the domain object directly
 * or an Effect of it — the Effect runs inside the Layer's construction
 * Effect, so it can `yield*` services; its requirements (`RMake`) join
 * the Layer's requirements.
 */
export type ProcessDomainArgs<L extends Context.Service<any, any>, RMake> = [
  keyof ProcessDomain<L["Service"]>,
] extends [never]
  ? []
  : [
      make: (
        inner: ProcessVerbsOf<L>,
      ) =>
        | ProcessDomain<L["Service"]>
        | Effect.Effect<ProcessDomain<L["Service"]>, never, RMake>,
    ];

/**
 * The kernel-derived default implementation Layer for a process term.
 *
 * The term's tag is the Layer's output; the term's construction
 * requirements (its refs' tags) plus the `Kernel` are the Layer's inputs.
 * Transitive elimination is Layer composition, which is what gives each
 * agent its own tool provisioning:
 *
 * ```ts
 * const FixLive = AI.layer(Fix).pipe(
 *   Layer.provide([
 *     AI.layer(Engineer).pipe(Layer.provide(BashDevBox)),  // read-write sandbox
 *     AI.layer(Judge).pipe(Layer.provide(BashOverlay)),    // copy-on-write verifier
 *     AI.layer(Scribe),
 *   ]),
 * )
 * ```
 *
 * Custom implementations bypass this entirely: an Agent/Process class is an
 * ordinary `Context.Service` tag, so `Layer.effect(Engineer, impl)` works
 * — the kernel default is a convenience, not a privilege.
 */
/** The deterministic handler shape `AI.process` lifts onto a term's ring. */
export type ProcessHandler<P, R = never> = (
  item: P extends Process<any, infer In, any, any, any, any[], any, any>
    ? In
    : unknown,
  ctx: ProcessContext,
) => Effect.Effect<
  P extends Process<infer Out, any, any, any, any, any[], any, any>
    ? Out
    : never,
  P extends Process<any, any, infer Err, any, any, any[], any, any>
    ? Err
    : never,
  R
>;

/**
 * The deterministic-handler Layer for a process term (reassess §C):
 * `AI.process(Channel, (post, ctx) => …)` implements the term's tag
 * with plain Effect code instead of a prose charter. The handler's own
 * requirements (child agent tags it dispatches, tools it uses) plus
 * `Kernel` are the Layer's inputs — discharged by ordinary Layer
 * composition, exactly like a term's tool tags under `AI.layer`.
 *
 * Two forms (canon §2 implementation Layers):
 *
 * - **effectful constructor** (preferred) — `AI.process(Term, Effect<
 *   Handler>)`: the Effect resolves dependencies ONCE at Layer build
 *   (the same convention as Worker fixtures) and returns the handler:
 *
 *   ```ts
 *   const Live = AI.process(Desk, Effect.gen(function* () {
 *     const sage = yield* Sage;                 // resolved once
 *     return (item, ctx) => Effect.gen(function* () { … });
 *   }));
 *   ```
 *
 * - **bare function** (sugar) — `AI.process(Term, (item, ctx) => …)`:
 *   the handler resolves its dependencies per run from the ambient
 *   context the Layer was built in.
 *
 * This is the DEFAULT way to write a coordinator/router: deterministic
 * routing in code, LLM judgment reserved for leaves the code calls.
 * The prose `Process` charter (`AI.layer`) is the rarer artifact for
 * genuinely open-ended goal jobs.
 *
 * An interface-bearing term (`AI.Process<Self, Interface>()`)
 * additionally REQUIRES a trailing `make` argument — same contract as
 * `AI.layer`'s ({@link ProcessDomainArgs}): the ring is built from the
 * handler as always, then the term's service is `make(ring)` — the
 * declared interface ONLY, closing over the sealed ring for delivery.
 */
export const process: {
  // effectful constructor: resolve dependencies once at Layer build
  <
    P extends Process<any, any, any, any, any, any[], any, any> &
      Context.Service<any, any>,
    R = never,
    RMake = never,
    RDomain = never,
  >(
    term: P,
    make: Effect.Effect<ProcessHandler<P, R>, never, RMake>,
    ...domain: ProcessDomainArgs<P, RDomain>
  ): Layer.Layer<P["Identifier"], never, Kernel | R | RMake | RDomain>;
  // bare-function sugar
  <
    P extends Process<any, any, any, any, any, any[], any, any> &
      Context.Service<any, any>,
    R = never,
    RDomain = never,
  >(
    term: P,
    handler: ProcessHandler<P, R>,
    ...domain: ProcessDomainArgs<P, RDomain>
  ): Layer.Layer<P["Identifier"], never, Kernel | R | RDomain>;
} = ((term: any, handler: any, makeDomain?: any): any =>
  Layer.effect(
    term,
    Effect.gen(function* () {
      const kernel = yield* Kernel;
      const resolved = Effect.isEffect(handler)
        ? yield* handler as Effect.Effect<any>
        : handler;
      const ring = yield* kernel.process(term, resolved);
      if (makeDomain === undefined) return ring;
      const made = makeDomain(ring);
      // sealed: the interface is the WHOLE service — the ring stays
      // internal, reachable only through what `make` chose to expose
      return Effect.isEffect(made) ? yield* made as Effect.Effect<any> : made;
    }) as any,
  )) as any;

export const layer: {
  <A extends Agent<any, any[], any, any> & Context.Service<any, AgentService>>(
    term: A,
  ): Layer.Layer<A["Identifier"], never, Kernel | A["~alchemy/Req"]>;
  /**
   * A plain term takes no further argument (its tag IS the actor). An
   * interface-bearing term (`AI.Process<Self, Interface>()`)
   * additionally REQUIRES `make` — the kernel interprets the charter as
   * always, then the term's service is `make(inner)`: the declared
   * interface ONLY. The interpreted verbs are SEALED inside — `make`
   * closes over `inner` for whatever delivery its methods need, and no
   * consumer can bypass the implementation with a raw `send`/`steer`.
   * This is the lightweight way to implement a declared interface:
   *
   * ```ts
   * const GitHubIssuesLive = AI.layer(GitHubIssues, (inner) => ({
   *   listIssues: () => …,   // may close over `inner` for send/steer
   *   getIssue: (number) => …,
   * }));
   * ```
   *
   * `make` may return an Effect (to `yield*` services once at Layer
   * build — its requirements join the Layer's). `Layer.effect(Term, …)`
   * remains the full-control form: interpret via `AI.Kernel` yourself,
   * wrap ingestion around it, return the interface.
   */
  <
    L extends Process<any, any, any, any, any, any[], any, any> &
      Context.Service<any, any>,
    RMake = never,
  >(
    term: L,
    ...make: ProcessDomainArgs<L, RMake>
  ): Layer.Layer<L["Identifier"], never, Kernel | L["req"] | RMake>;
} = (term: any, make?: any): any =>
  Layer.effect(
    term,
    Effect.gen(function* () {
      const kernel = yield* Kernel;
      const inner = yield* kernel.interpret(term as any);
      if (make === undefined) return inner;
      const made = make(inner);
      // sealed: the interface is the WHOLE service — the verbs stay
      // internal, reachable only through what `make` chose to expose
      return Effect.isEffect(made) ? yield* made as Effect.Effect<any> : made;
    }) as any,
  );
