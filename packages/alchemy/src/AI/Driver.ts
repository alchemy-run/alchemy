import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as PersistentRef from "../PersistentRef.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Actor, Agent, AgentService, Stub, StubVerbs } from "./Agent.ts";
import type { DriverError } from "./Errors.ts";
import type { Fragment } from "./Fragment.ts";
import type { Thread, Tick } from "./Thread.ts";
import {
  isSkill,
  type Skill,
  type SkillLayer,
  type SkillService,
} from "./Skill.ts";
import { bindSource, isSource } from "./Source.ts";
import { isTool } from "./Tool.ts";

/**
 * The one term kind the Driver can interpret: an {@link Agent}.
 * Capability terms (`Tool`/`Thing`) are compiled *into* their
 * host's turns — they have no sessions and no loop of their own. A
 * domain-shaped surface (a process) is not a term at all: it is a
 * plain `Context.Service` whose hand-written Layer interprets a
 * PRIVATE agent and wires the world to its verbs.
 */
export type Interpretable = Agent<any, any, any>;

/**
 * The TURN half of a charter: re-entrant, evaluated by the driver
 * before EVERY sampling of every session. Its result is what the session IS
 * right now:
 *
 * - a {@link Fragment} — the stance: what the persona knows, which
 *   tools it holds, which delegates it may call, this tick. Mention is
 *   presence: a tool a branch does not render is not in the toolkit.
 *   The turn returns the stance and NOTHING ELSE — answering a caller
 *   is the explicit {@link reply} act (from a tool handler or turn
 *   code), never a return value.
 * - a failure — retried by the driver with capped backoff; a typed
 *   `AI.Refused` is the session giving up, riding the error channel.
 *
 * Returning an un-yielded Effect (a forgotten `yield*` on `AI.fragment`)
 * or any non-Fragment value is a loud defect, never a silent outcome.
 */
export type Turn<E = any, R = any> = Effect.Effect<Fragment, E, R>;

/**
 * The EVENT one tick is about — passed to a function-form turn (the
 * guard tier), so deterministic per-tick policy sees what it is
 * deciding over without reaching for ambient services.
 */
export interface TickEvent<In = unknown> {
  /** Samplings performed so far in this session (the budget clock). */
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
 * What a session's CONSTRUCTOR returns — the session's behavior and,
 * optionally, its API:
 *
 * - a {@link Fragment} — a constant stance (the common case);
 * - a {@link Turn} — an Effect re-evaluated every sampling;
 * - a {@link TurnFn} — the guard tier, a function of the tick event;
 * - a {@link SessionObject} — `{ turn, ...methods }`: the turn under
 *   the one reserved key, and every other key a METHOD callers reach
 *   through `agent.at(key).method(...)`.
 */
export type SessionResult = Fragment | Turn | TurnFn | SessionObject;

/**
 * A session with an API: the turn under the reserved `turn` key and
 * methods beside it. Methods run INSIDE the session frame (the same
 * context a tool handler gets — `AI.Thread`, the `PersistentRef.Store`
 * framed by the session, the captured Layer), so a method reads which
 * session it acts for from the frame, never from a closure. Their
 * arguments, results, and typed failures must be structured-clonable:
 * on Cloudflare a method call is one RPC hop into the session's
 * Durable Object, and the resident placement enforces the same so the
 * two never drift.
 */
export interface SessionObject {
  readonly turn: Fragment | Turn | TurnFn;
  readonly [method: string]: unknown;
}

/**
 * A charter is the IMPLEMENTATION of an Agent — what `Engineer.make`
 * takes, or the second argument of the class declaration. ONE Effect,
 * run ONCE where the Layer builds (plan time in the deploy process,
 * once per isolate at runtime) — exactly like a Worker body. It
 * declares, in one scope, everything the agent IS: the resources and
 * bindings it reaches, the tools it can call, the methods it answers.
 * The deploy sees that whole graph before any session exists, which
 * is what lets an agent's capability be read declaratively and tied
 * to the infrastructure it touches.
 *
 * ```ts
 * Effect.gen(function* () {
 *   // bindings — discovered by the planner
 *   const artifacts = yield* Cloudflare.R2.Bucket("Artifacts", {});
 *   const store = yield* Cloudflare.R2.ReadWriteBucket(artifacts);
 *   // per-session STATE, declared: a named cell; resolves against the
 *   // session's store in whichever frame touches it
 *   const model = PersistentRef.of("model", () => DEFAULT);
 *   // tools — minted here, beside the bindings they close over
 *   const read = yield* AI.Tool("read")`…`(Effect.fn(function* (p) {
 *     return yield* store.get(p.key);
 *   }));
 *   return {
 *     turn: Effect.gen(function* () {
 *       const { key } = yield* AI.Thread;           // the session, at sampling
 *       return yield* AI.fragment`You work on ${key}. ${read}`;
 *     }),
 *     setModel: (id: string) => PersistentRef.set(model, id),
 *   };
 * })
 * ```
 *
 * There is NO per-session constructor. The session is ambient: turns,
 * tool handlers, and methods run inside the session's frame and read
 * `AI.Thread` (its identity, its conversation) and the
 * `PersistentRef.Store` (its durable cells) from there. Nothing is
 * closed over per session, so nothing hides from the plan. The charter
 * itself has no session — `AI.Thread`, `AI.Tick`, and the store are
 * absent, and reaching for them at the top level fails the build,
 * loudly — and nothing disposable may be acquired there (it runs
 * under planning, with no sessions live).
 *
 * A bare {@link Fragment} (the tagged-template shorthand `Reviewer.make`…``
 * is this) is the constant stance with no API. A static stance is
 * byte-identical every tick — the prompt cache never busts; the guard
 * tier costs nothing extra when the stance it returns is constant.
 * Re-rendering a DIFFERENT stance mid-session is possible and
 * occasionally right, but it replaces the system prompt
 * (cache-busting) — skills (model-pulled) and messages are the cheap
 * dynamism channels.
 */
export type Charter = Effect.Effect<SessionResult, any, any>;

/**
 * The services the driver itself provides while evaluating a session's
 * TURN, its tool handlers, and its methods — excluded from a charter's
 * inferred requirements because no user Layer could ever provide them.
 *
 * These are RUNTIME facts and affordances: `Thread` (the session's
 * identity and conversation), `Tick` (this sampling), and the
 * `PersistentRef.Store` (durable named state, framed by the session's
 * identity — the opt-in named-state capability both drivers provide).
 * None exists while the charter itself runs (there is no session at
 * plan time); `Tick` exists only inside the loop, so turns and tool
 * handlers see it and methods do not.
 */
export type TurnServices = Thread | Tick | RuntimeContext | PersistentRef.Store;

/** The requirements of one session result, minus the frame. */
export type ResultServices<A> =
  A extends Effect.Effect<any, any, infer RTurn>
    ? Exclude<RTurn, TurnServices>
    : A extends (tick: any) => Effect.Effect<any, any, infer RTurn>
      ? Exclude<RTurn, TurnServices>
      : A extends SessionObject
        ?
            | ResultServices<A["turn"]>
            | {
                [K in Exclude<keyof A, "turn">]: A[K] extends (
                  ...args: any
                ) => Effect.Effect<any, any, infer RMethod>
                  ? Exclude<RMethod, TurnServices>
                  : never;
              }[Exclude<keyof A, "turn">]
        : never;

/**
 * A charter's requirement union — what its Layer needs: the charter's
 * own requirements (its bindings and tools), and everything any turn
 * or method could mention (splices accumulate through `AI.fragment`'s
 * requirement channel — including branches that did not render this
 * tick), minus the driver-provided {@link TurnServices}.
 */
export type CharterServices<C> =
  C extends Effect.Effect<infer A, any, infer RBuild>
    ? Exclude<RBuild, TurnServices> | ResultServices<A>
    : never;

/**
 * The Driver is the interpreter of {@link Agent} terms — one method.
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
 * are COMPONENT Layers a particular driver *implementation* requires
 * by name — invisible to this contract.
 */
export interface DriverService {
  readonly interpret: (
    term: Interpretable,
    charter: Charter,
  ) => Effect.Effect<Actor, DriverError, Scope.Scope>;
}

export class Driver extends Context.Service<Driver, DriverService>()(
  "alchemy/AI/Driver",
) {}

const STUB_VERBS: ReadonlySet<string> = new Set([
  "dispatch",
  "send",
  "steer",
  "settle",
  "stop",
  "resume",
  "destroy",
]);

/**
 * Build the session {@link Stub} over an actor — the verbs bound to
 * the key, every other name a METHOD call through `actor.call`. No
 * I/O: like a Durable Object stub, the first verb admits the session,
 * every later one finds it.
 */
export const makeStub = (actor: Actor, key: string): Stub<unknown> => {
  const verbs: StubVerbs = {
    dispatch: (item) => actor.dispatch(item, { key }),
    send: (item, options) => actor.send(item, { key, wake: options?.wake }),
    steer: (item) => actor.steer(key, item),
    settle: (outcome) => actor.settle(key, outcome),
    stop: () => actor.stop(key),
    resume: () => actor.resume(key),
    destroy: (options) => actor.destroy(key, options),
  };
  return new Proxy(verbs as Stub<unknown>, {
    get: (target, name) =>
      typeof name === "string" && !STUB_VERBS.has(name) && !(name in target)
        ? (...args: ReadonlyArray<unknown>) => actor.call(key, name, args)
        : Reflect.get(target, name),
  });
};

/** The agent namespace over an interpreted actor: the verbs plus `at`.
 *  `Contract` types the stubs (`AI.ContractOf<typeof charter>`) for
 *  code that interprets directly instead of resolving a tag. */
export const withStubs = <Contract = unknown>(
  actor: Actor,
): AgentService<Contract> =>
  Object.assign(actor, {
    at: (key: string) => makeStub(actor, key),
  }) as AgentService<Contract>;

/**
 * The driver-default implementation Layer for an AGENT term — spelled
 * `Engineer.make(charter)` — the term's tag out; `Driver` plus
 * everything the charter's fragments mention in. Transitive
 * elimination is Layer composition — each agent gets its own
 * capability provisioning via `Layer.provide`.
 *
 * Agent-only, by design: an agent's tag IS the {@link Actor} verbs
 * `interpret` returns, so the driver can implement it mechanically. A
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
 * ONE delivery verb — it admits the session on first sight of its key and
 * enqueues thereafter (so a re-delivered event after a crash re-admits
 * the session: level-triggered recovery); `settle(key, outcome)` is the
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
   * tools — and rides the Layer itself as static `template` / `refs`
   * (`Teaching` in Skill.ts), so the same text can be rendered as a document
   * without building the Layer. A custom `Layer.effect(Coding, …)` may
   * instead build the whole bundle inline.
   */
  <
    L extends Skill<any, any> & Context.Service<any, any>,
    const Refs extends any[],
  >(
    term: L,
    template: TemplateStringsArray,
    ...refs: Refs
  ): SkillLayer<L["Identifier"], Refs>;
  /**
   * The default AGENT Layer: interpret the charter, publish the verbs
   * as the tag's service.
   */
  <A extends Agent<any, any> & Context.Service<any, any>, C extends Charter>(
    term: A,
    charter: C,
  ): Layer.Layer<A["Identifier"], never, Driver | CharterServices<C>>;
} = ((term: any, charterOrTemplate?: any, ...refs: any[]) =>
  isSkill(term)
    ? Object.assign(
        Layer.effect(
          term as any,
          Effect.gen(function* () {
            const template = charterOrTemplate as TemplateStringsArray;
            const context = yield* Effect.context<never>();
            const tools: SkillService["tools"] = {};
            for (const ref of refs) {
              if (isSource(ref)) {
                // resolve the file's path where it is true (plan) and bind
                // it for where it is not (the bundled runtime) — Source.ts
                yield* bindSource(ref);
                continue;
              }
              if (!isTool(ref)) continue;
              const name = (ref as { "~alchemy/Name": string })[
                "~alchemy/Name"
              ];
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
        ),
        // the teaching as static data on the Layer (Teaching)
        { template: charterOrTemplate as TemplateStringsArray, refs },
      )
    : Layer.effect(
        term,
        Effect.orDie(
          Effect.map(
            Effect.flatMap(Driver, (driver) =>
              driver.interpret(term, charterOrTemplate),
            ),
            withStubs,
          ),
        ) as any,
      )) as any;
