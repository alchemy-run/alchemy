import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Actor } from "./Actor.ts";
import type { Agent } from "./Agent.ts";
import type { KernelError } from "./Errors.ts";
import type { Fragment } from "./Prose.ts";
import type { Thread, Tick } from "./Thread.ts";
import type { Services } from "./Services.ts";
import { isSkill, type Skill, type SkillService } from "./Skill.ts";
import { isTool } from "./Tool.ts";

/**
 * The one term kind the Kernel can interpret: an {@link Agent}.
 * Capability terms (`Tool`/`Parameter`) are compiled *into* their
 * host's turns — they have no runs and no loop of their own. A
 * domain-shaped surface (a process) is not a term at all: it is a
 * plain `Context.Service` whose hand-written Layer interprets a
 * PRIVATE agent and wires the world to its verbs.
 */
export type Interpretable = Agent<any, any>;

/**
 * The TURN half of a charter: re-entrant, evaluated by the kernel
 * before EVERY sampling of every run. Its result is what the run IS
 * right now:
 *
 * - a {@link Fragment} — the stance: what the persona knows, which
 *   tools it holds, which delegates it may call, this tick. Mention is
 *   presence: a tool a branch does not render is not in the toolkit.
 *   The turn returns the stance and NOTHING ELSE — answering a caller
 *   is the explicit {@link reply} act (from a tool handler or turn
 *   code), never a return value.
 * - a failure — retried by the kernel with capped backoff; a typed
 *   `AI.Refused` is the run giving up, riding the error channel.
 *
 * Returning an un-yielded Effect (a forgotten `yield*` on `AI.prose`)
 * or any non-Fragment value is a loud defect, never a silent outcome.
 */
export type Turn<E = any, R = any> = Effect.Effect<Fragment, E, R>;

/**
 * The EVENT one tick is about — passed to a function-form turn (the
 * guard tier), so deterministic per-tick policy sees what it is
 * deciding over without reaching for ambient services.
 */
export interface TickEvent<In = unknown> {
  /** Samplings performed so far in this run (the budget clock). */
  readonly count: number;
  /**
   * The messages drained at this boundary — work items, steers,
   * reminder notes. Empty when a turn re-evaluates without new input.
   * Typed by the charter's declared event alphabet where annotated.
   */
  readonly inputs: ReadonlyArray<In>;
}

/**
 * The FUNCTION form of a turn: `(TickEvent) => Effect<Fragment>` — a
 * reducer from what-just-happened to how-to-stand, with laws checked
 * on the way (budgets, refusals, scheduled pressure notes). Prefer
 * this over the bare-Effect turn when the guard needs the tick.
 */
export type TurnFn<In = unknown, E = any, R = any> = (
  tick: TickEvent<In>,
) => Effect.Effect<Fragment, E, R>;

/**
 * A charter is the BEHAVIOR of an Agent or Process: an INIT effect
 * that runs once per RUN (the closure is the component instance —
 * allocate `Ref`s, resolve bindings for tools, define inline tools
 * over both) and returns the {@link Turn} the kernel re-evaluates at
 * every sampling boundary of that run.
 *
 * Init IS thread-scoped: it runs at admit, when the run's thread
 * already exists, so `AI.Thread` is in scope — set up state FOR the
 * thread there (a workspace checkout keyed by `thread.key`, Refs the
 * turn and tools share). `AI.Tick` is the one runtime fact init never
 * sees: no sampling is under way, so only turns and tool handlers may
 * yield it.
 *
 * The three tiers, static-first:
 *
 * ```ts
 * // 1. static prose — most agents
 * Reviewer.make`You review each ${pr} against …`;
 *
 * // 2. a closure (tools, refs, bindings) returning a STATIC stance
 * Engineer.make(Effect.gen(function* () {
 *   const openPullRequest = yield* AI.Tool("open_pull_request")`…`(…);
 *   return AI.prose`…${openPullRequest}…`;      // Fragment → constant turn
 * }));
 *
 * // 3. the GUARD tier — a function of the tick event, for laws the
 * //    model cannot be trusted to enforce on itself
 * Engineer.make(Effect.gen(function* () {
 *   const stance = AI.prose`…`;
 *   return Effect.fn(function* (tick: AI.TickEvent) {
 *     if (tick.count >= 60) return yield* Effect.fail(new AI.Refused({ … }));
 *     if (tick.count === 45) yield* AI.say`45 of 60 spent — converge.`;
 *     return yield* stance;
 *   });
 * }));
 * ```
 *
 * A static stance is byte-identical every tick — the prompt cache
 * never busts; the guard tier costs nothing extra when the stance it
 * returns is constant. Re-rendering a DIFFERENT stance mid-run is
 * possible and occasionally right, but it replaces the system prompt
 * (cache-busting) — skills (model-pulled) and messages are the cheap
 * dynamism channels.
 */
export type Charter = Effect.Effect<Fragment | Turn | TurnFn, any, any>;

/**
 * The services the kernel itself provides while evaluating a run's
 * TURN and its tool handlers — excluded from a charter's inferred
 * requirements because no user Layer could ever provide them.
 *
 * These are RUNTIME facts and affordances: `Thread` (the run's
 * identity and conversation) and `Tick` (this sampling). Init runs
 * ONCE PER RUN at admit — the thread already exists, so init MAY read
 * `Thread` for thread-scoped setup (a `Ref` keyed by the run, a
 * workspace checkout addressed by `thread.key`). `Tick` exists only
 * inside the loop: no sampling is under way during init, so only
 * turns and tool handlers see it.
 */
export type TurnServices = Thread | Tick | RuntimeContext;

/**
 * A charter's requirement union: the init effect's own requirements
 * (`Thread` excluded — init is per-run and the kernel provides the
 * thread at admit; `Tick` NOT excluded, so an init that yields it
 * surfaces an unprovideable requirement here and fails to compose)
 * plus everything any turn could mention (splices accumulate through
 * `AI.prose`'s requirement channel — including branches that did not
 * render this tick), minus the kernel-provided {@link TurnServices}.
 */
export type CharterServices<C> =
  C extends Effect.Effect<infer A, any, infer RInit>
    ?
        | Exclude<RInit, Thread | RuntimeContext>
        | (A extends Effect.Effect<any, any, infer RTurn>
            ? Exclude<RTurn, TurnServices>
            : A extends (tick: any) => Effect.Effect<any, any, infer RTurn>
              ? Exclude<RTurn, TurnServices>
              : never)
    : never;

/**
 * The Kernel is the interpreter of {@link Agent} terms — one method.
 *
 * `interpret` turns a term (a bare tag) plus its CHARTER (init → turn)
 * into the live {@link Actor} verbs, resolving every capability the
 * charter's fragments mention from the ambient context (which is why
 * `CharterServices` rides the requirement channel of the public
 * {@link interpret} helper). Interpretation is **scoped**: it acquires
 * the term's single serial loop, whose lifetime is the Scope's.
 *
 * A PUBLIC agent's verbs are its tag's service ({@link layer} — via
 * `Engineer.make(charter)` — packages that). A sealed domain surface
 * (a business process) is a plain `Context.Service` whose hand-written
 * Layer interprets a PRIVATE agent, wires the world to the verbs, and
 * exposes only the declared Shape.
 *
 * Note the vocabulary that is absent: memory, compaction, context,
 * sandbox, session-store, sub-agent, model, event bus, trace. Those
 * are COMPONENT Layers a particular kernel *implementation* requires
 * by name — invisible to this contract.
 */
export interface KernelService {
  readonly interpret: (
    term: Interpretable,
    charter: Charter,
  ) => Effect.Effect<Actor, KernelError, Scope.Scope>;
}

export class Kernel extends Context.Service<Kernel, KernelService>()(
  "alchemy/AI/Kernel",
) {}

/**
 * The kernel-default implementation Layer for an AGENT term — spelled
 * `Engineer.make(charter)` — the term's tag out; `Kernel` plus
 * everything the charter's fragments mention in. Transitive
 * elimination is Layer composition — each agent gets its own
 * capability provisioning via `Layer.provide`.
 *
 * Agent-only, by design: an agent's tag IS the {@link Actor} verbs
 * `interpret` returns, so the kernel can implement it mechanically. A
 * sealed domain Shape (a business process) is a plain
 * `Context.Service` — its hand-written Layer resolves a PRIVATE
 * agent's tag and hides the verbs behind the declared Shape:
 *
 * ```ts
 * export class Issues extends Context.Service<Issues, IssuesService>()(
 *   "alchemy-org/Issues",
 * ) {}
 *
 * // the loop behind the desk — not exported, so nobody can drive it
 * class IssuesAgent extends AI.Agent<IssuesAgent>()("Issues") {}
 * const IssuesAgentLive = IssuesAgent.make(charter);
 *
 * export const IssuesLive = Layer.effect(Issues, Effect.gen(function* () {
 *   const issuesAgent = yield* IssuesAgent;          // the loop, private
 *   yield* GitHub.consumeRepositoryEvents(repo, …);  // the world drives it
 *   return { list: … };                              // the Shape, public
 * })).pipe(Layer.provide(IssuesAgentLive));
 * ```
 *
 * Delivery discipline for the wiring: `send(event, { key })` is the
 * ONE delivery verb — it admits the run on first sight of its key and
 * enqueues thereafter (so a re-delivered event after a crash re-admits
 * the run: level-triggered recovery); `settle(key, outcome)` is the
 * one ending. Dedupe of at-least-once DELIVERIES (webhook
 * redeliveries, poll re-observations) belongs to the Layer — offer
 * the event's content to the Ledger and drop duplicates.
 */
export const layer: {
  /**
   * The SKILL Layer — `Coding.make`…`` packages this: the skill's tag
   * out, the TEMPLATE's spliced tools' tags in. The teaching (prose +
   * splices) rides the service value, so different implementations of
   * one skill contract may teach different prose over different
   * tools. A custom `Layer.effect(Coding, …)` may instead build the
   * whole bundle inline.
   */
  <
    L extends Skill<any, any> & Context.Service<any, any>,
    const Refs extends any[],
  >(
    term: L,
    template: TemplateStringsArray,
    ...refs: Refs
  ): Layer.Layer<L["Identifier"], never, Services<Refs>>;
  /**
   * The default AGENT Layer: interpret the charter, publish the verbs
   * as the tag's service.
   */
  <A extends Agent<any, any> & Context.Service<any, any>, C extends Charter>(
    term: A,
    charter: C,
  ): Layer.Layer<A["Identifier"], never, Kernel | CharterServices<C>>;
} = ((term: any, charterOrTemplate?: any, ...refs: any[]) =>
  isSkill(term)
    ? Layer.effect(
        term as any,
        Effect.gen(function* () {
          const template = charterOrTemplate as TemplateStringsArray;
          const context = yield* Effect.context<never>();
          const tools: SkillService["tools"] = {};
          for (const ref of refs) {
            if (!isTool(ref)) continue;
            const name = (ref as { "~alchemy/Name": string })["~alchemy/Name"];
            const service = Context.getOption(context, ref as any);
            if (Option.isNone(service)) {
              return yield* Effect.die(
                `AI.layer: no implementation provided for tool '${name}' of skill '${term["~alchemy/Name"]}'`,
              );
            }
            tools[name] = Effect.isEffect(service.value)
              ? yield* service.value as Effect.Effect<any>
              : service.value;
          }
          return { template, refs, tools } satisfies SkillService;
        }) as any,
      )
    : Layer.effect(
        term,
        Effect.orDie(
          Effect.flatMap(Kernel, (kernel) =>
            kernel.interpret(term, charterOrTemplate),
          ),
        ) as any,
      )) as any;
