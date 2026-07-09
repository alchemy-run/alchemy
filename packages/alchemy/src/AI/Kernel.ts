import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { Agent, AgentService } from "./Agent.ts";
import type { KernelError } from "./Errors.ts";
import type { Loop, LoopService } from "./Loop.ts";

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
 *   trigger ref that produced this event (a seam without provenance rots
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
  /** The parent command id / trigger ref that caused this event. */
  readonly cause?: string;
  /** Caller provenance: who created the session vs who caused this turn. */
  readonly auth?: { readonly initiator: string; readonly current: string };
  readonly payload?: unknown;
}

/**
 * The Kernel is the interpreter of **process terms** (Agent | Loop) —
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
 * (design §1 taxonomy). Agent and Loop denote the same object — a
 * Process `In → Run<Out, Err>` (see
 * designs/ai/reports/agent-loop-algebra.md); they differ only in *who
 * supplies the control parameters* (kernel defaults vs charter refs),
 * so interpretation is one method, not two.
 *
 * The other term classes never appear here: capability terms
 * (`Tool`/`Parameter`) are compiled *into* their host process's turn
 * (toolkit schema + handler resolved from context), and control refs
 * (`Trigger`/`Halt`/`Fold`/`Check`/`Budget`/`Concurrency`/`Observe`)
 * parameterize the host's ring. Neither has runs, an inbox, or a ring
 * of its own.
 */
export type InterpretableTerm =
  | Agent<any, any[], any, any>
  | Loop<any, any, any, any, any, any[], any>;

/** The service an interpreted process term produces. */
export type TermService<T> =
  T extends Loop<infer Out, infer In, infer Err, any, any, any[], any>
    ? LoopService<Out, In, Err>
    : T extends Agent<any, any[], any, any>
      ? AgentService
      : never;

/** The term's construction requirements (its refs' tags). */
export type TermReq<T> =
  T extends Loop<any, any, any, infer Req, any, any[], any>
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
 * Custom implementations bypass this entirely: an Agent/Loop class is an
 * ordinary `Context.Service` tag, so `Layer.effect(Engineer, impl)` works
 * — the kernel default is a convenience, not a privilege.
 */
export const layer: {
  <A extends Agent<any, any[], any, any> & Context.Service<any, AgentService>>(
    term: A,
  ): Layer.Layer<A["Identifier"], never, Kernel | A["~alchemy/Req"]>;
  <
    L extends Loop<any, any, any, any, any, any[], any> &
      Context.Service<any, LoopService<any, any, any>>,
  >(
    term: L,
  ): Layer.Layer<L["Identifier"], never, Kernel | L["req"]>;
} = (term: any): any =>
  Layer.effect(
    term,
    Effect.gen(function* () {
      const kernel = yield* Kernel;
      return yield* kernel.interpret(term as any);
    }) as any,
  );
