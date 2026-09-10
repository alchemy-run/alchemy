import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  layer,
  type Charter,
  type CharterServices,
  type Driver,
  type SessionObject,
  type SessionResult,
  type Turn,
  type TurnFn,
  type TurnServices,
} from "./Driver.ts";
import { fragment, type Fragment, type Services } from "./Fragment.ts";
import { makeSource, type Source } from "./Source.ts";
import type { Tool, ToolParameters } from "./Tool.ts";

// ─────────────────────────── the Actor ────────────────────────────

/** A reference to a driver session: which term, which key. */
export interface SessionRef {
  readonly term: string;
  readonly key: string;
}

/**
 * The Actor — what resolving an {@link Agent} tag yields, and what the
 * driver returns when it interprets any term's charter: a mailbox with
 * a serial session loop, spoken to only in the actor verbs. Hand it
 * work (`dispatch`/`send`), talk to a session mid-flight (`steer`),
 * resolve a session from the outside (`settle`).
 *
 * Who may hold the Actor is a Layer decision. A PUBLIC {@link Agent}'s
 * tag IS its Actor — agents exist to be called. A sealed domain
 * surface (a business process) is a plain `Context.Service` whose
 * Layer interprets a PRIVATE agent and exposes only its declared
 * Shape — the Actor never leaves the closure.
 *
 * `In` is the term's input alphabet, DERIVED FROM ITS PROSE: the
 * union of the `AI.Event` payloads its charter splices, plus `string`
 * (always allowed). A charter that declares no events leaves `In` at
 * `unknown`. `settle` deliberately stays `unknown` — the outcome
 * belongs to the world, not to the charter's declarations.
 *
 * Sessions are keyed at admission; `steer`/`settle` address them by
 * that key.
 */
export interface Actor<In = unknown> {
  /**
   * Admit one work item and await its session's resolution (admit +
   * join). `options.key` names the session (see {@link Actor.send}).
   */
  dispatch(
    item: In,
    options?: {
      readonly key?: string;
      readonly parent?: SessionRef;
    },
  ): Effect.Effect<unknown, never, RuntimeContext>;
  /**
   * Admit one work item, fire-and-forget (the admission half alone).
   *
   * `options.key` is the session's CALLER-CHOSEN name — the world
   * identity to correlate by (`owner/repo#7`). Naming the session is
   * what makes `steer(key, …)` and `settle(key, …)` addressable from
   * code that never saw a driver-minted session.
   *
   * `options.parent` records WHICH SESSION caused this admission — the
   * driver's own `dispatch` intrinsic stamps it automatically, so
   * observability can reconstruct the delegation tree (issue desk →
   * engineer → …). Purely observational: it never affects routing.
   */
  send(
    item: In,
    options?: {
      readonly key?: string;
      readonly parent?: SessionRef;
      /**
       * `wake: false` delivers WITHOUT waking: the input lands in the
       * session's thread durably, but a parked session stays parked —
       * the accumulated inputs are read on its next wake (an operator
       * message, a reminder, a waking send), and a BUSY session picks
       * them up at its next sampling boundary as usual. The
       * level-triggered delivery mode: events as CONTEXT, not
       * triggers. Default `true` (a send wakes a parked session).
       */
      readonly wake?: boolean;
    },
  ): Effect.Effect<void, never, RuntimeContext>;
  /**
   * Session-key–addressed input: deliver a message to a SPECIFIC
   * session, promoted at the session's next boundary (wakes a parked
   * session for another work round).
   */
  steer(
    sessionKey: string,
    input: In,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Mid-session input to the active session, promoted at the next
   *  boundary. */
  steer(input: In): Effect.Effect<void, never, RuntimeContext>;
  /**
   * End a SPECIFIC session from the outside: the session resolves with
   * `event` as its outcome. The caller that consumed the wire owns
   * session endings — the driver just runs the loop. Settling a key
   * with no live session is an idempotent no-op (the session may have
   * settled already — the world outranks the org's beliefs).
   */
  settle(
    sessionKey: string,
    event: unknown,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Scope authority: settle in-flight work as interrupted. */
  interrupt(): Effect.Effect<void, never, RuntimeContext>;
  /**
   * Call one METHOD of a session's API (the keys beside `turn` on its
   * charter's result) inside the session frame. Admits the key on
   * first contact. A method the session does not declare is a defect;
   * the method's own typed failure rides the error channel. The typed
   * face of this is the {@link Stub} from `at`.
   */
  call(
    sessionKey: string,
    method: string,
    args: ReadonlyArray<unknown>,
  ): Effect.Effect<unknown, unknown, RuntimeContext>;
  /** The operator's stop for one session: settle it in place (children
   *  cascade, the round in flight is cut); the object stays. */
  stop(sessionKey: string): Effect.Effect<void, never, RuntimeContext>;
  /** The undo for `stop`: clear the settled tombstone; the next input
   *  opens a round. */
  resume(sessionKey: string): Effect.Effect<void, never, RuntimeContext>;
  /** Erase one session: settle, cut the round, purge its rows, so the
   *  key can be admitted fresh. `machine` (default true) also takes
   *  the session's sandbox machine down — false when siblings share it. */
  destroy(
    sessionKey: string,
    options?: { readonly machine?: boolean },
  ): Effect.Effect<void, never, RuntimeContext>;
}

// ──────────────────────── the API surface ─────────────────────────

/** The names every session stub carries — an API may not reuse them. */
export type ReservedVerbs =
  | "turn"
  | "dispatch"
  | "send"
  | "steer"
  | "settle"
  | "stop"
  | "resume"
  | "destroy";

/** The METHODS of a charter's result: everything beside `turn`. */
export type ApiOf<Result> = Result extends SessionObject
  ? { readonly [K in Exclude<keyof Result, "turn">]: Result[K] }
  : {};

/**
 * The CONTRACT an agent class may declare as its second type
 * parameter — the session's API, an interface of methods — or, when
 * omitted, the contract INFERRED from the implementation (see
 * {@link ContractOf}). A session is not constructed: what varies per
 * session is STATE, set through its methods.
 */
export type ContractApi<Contract> = Contract extends object ? Contract : {};

/** The contract inferred from an implementation ({@link Charter}). */
export type ContractOf<C> =
  C extends Effect.Effect<infer A, any, any> ? ApiOf<A> : never;

/** Reserved names an API wrongly reuses (`never` when clean). */
export type ReservedIn<Contract> = Extract<
  keyof ContractApi<Contract>,
  ReservedVerbs
>;

/**
 * The implementation a DECLARED contract admits: a charter whose
 * result carries the contract's methods (each checked by arguments,
 * success, and failure — the frame in `R` is the implementation's
 * business).
 */
export type ImplementationOf<Contract> = unknown extends Contract
  ? Charter
  : Effect.Effect<ResultFor<ContractApi<Contract>>, any, any>;

/** The session result a declared API demands. */
export type ResultFor<Api> = keyof Api extends never
  ? SessionResult
  : { readonly turn: Fragment | Turn | TurnFn } & {
      readonly [K in keyof Api]: Api[K] extends (
        ...args: infer Args
      ) => Effect.Effect<infer A, infer E, any>
        ? (...args: Args) => Effect.Effect<A, E, any>
        : never;
    };

/** The loop verbs on a session stub — the {@link Actor} verbs with the
 *  key bound. */
export interface StubVerbs<In = unknown> {
  readonly dispatch: (
    item: In,
  ) => Effect.Effect<unknown, never, RuntimeContext>;
  readonly send: (
    item: In,
    options?: { readonly wake?: boolean },
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly steer: (item: In) => Effect.Effect<void, never, RuntimeContext>;
  readonly settle: (
    outcome: unknown,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly stop: () => Effect.Effect<void, never, RuntimeContext>;
  readonly resume: () => Effect.Effect<void, never, RuntimeContext>;
  readonly destroy: (options?: {
    readonly machine?: boolean;
  }) => Effect.Effect<void, never, RuntimeContext>;
}

/** The API as callers see it: each method's `R` is the runtime color
 *  alone — the driver supplies the session frame. */
export type StubMethods<Api> = {
  readonly [K in keyof Api]: Api[K] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, infer E, any>
    ? (...args: Args) => Effect.Effect<A, E, RuntimeContext>
    : never;
};

/**
 * One session, addressed: `engineer.at(key)` — no I/O; the loop verbs
 * with the key bound, plus the agent's declared methods. Like a
 * Durable Object stub: the first verb admits the session, every later
 * one finds it.
 */
export type Stub<Contract = unknown, In = unknown> = StubVerbs<In> &
  StubMethods<ContractApi<Contract>>;

/**
 * What resolving an {@link Agent} tag yields: the {@link Actor} verbs
 * (the namespace — mint a session, address one by key) plus `at`, the
 * typed stub for one session.
 */
export type AgentService<Contract = unknown, In = unknown> = Actor<In> & {
  readonly at: 0 extends 1 & Contract
    ? (key: string) => Stub<any, In>
    : (key: string) => Stub<Contract, In>;
};

/**
 * An `Agent` term is a callable persona — a NAME, declared as a
 * `Context.Service` tag and nothing else. The agent's behavior (its
 * prose, tools, skills, delegates) lives in a CHARTER supplied where
 * the agent is implemented — `Engineer.make(charter)` — never on
 * the declaration. Decoupling the two is deliberate: one contract can
 * carry many charters (a strict Engineer in prod, a chatty one in
 * dev), and a charter can be dynamic (re-evaluated at every sampling
 * boundary) without the declaration knowing.
 *
 * Every agent's tag resolves to the SAME interface — the
 * {@link Actor} verbs — because agents exist to be called: an owner
 * hands the Engineer a ready issue (`dispatch`) and awaits the pull
 * request. A domain-specific, deterministic surface (a business
 * process) is not a term: declare a plain `Context.Service` Shape,
 * declare a PRIVATE (un-exported) agent beside it with its own `make`
 * Layer, and have the Shape's Layer resolve the agent's tag — the
 * verbs stay sealed inside the Layer, and the world drives them.
 *
 * ```ts
 * export class Engineer extends AI.Agent<Engineer>()("Engineer") {}
 *
 * export const EngineerLive = Engineer.make`
 * You receive exactly one ${issue}. ${Coding} is your craft; when
 * green, ${OpenPullRequest} citing the issue.`;
 * ```
 *
 * Capability lives entirely in the charter's fragments: interpolating
 * `${Engineer}` in ANOTHER charter's prose contributes the tag
 * `Engineer` to that charter's requirements — not the agent's tools.
 * Transitivity lives in Layer composition: each agent gets its own
 * capability provisioning
 * (`Engineer.make(c1).pipe(Layer.provide(BashDevBox))` vs
 * `Judge.make(c2).pipe(Layer.provide(BashReadOnly))` — one
 * contract, different physics, side by side in one runtime).
 *
 * Capability denial by omission: a charter that never interpolates
 * `${Approve}` has no `Approve` anywhere in its Layer graph's
 * requirements; no Layer can grant it merge authority. Constitutional
 * constraints are enforced by the type system, not by prose.
 */
export interface Agent<
  Name extends string = string,
  Self = unknown,
  Contract = unknown,
> {
  "~alchemy/Kind": "Agent";
  "~alchemy/Name": Name;
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
  /** Phantom carrier for the declared (or inferred) contract. */
  "~alchemy/Contract": Contract;
  /**
   * The file this agent is defined in — present when the term was
   * declared as `AI.Agent<Self>(import.meta)(name)`. Splice
   * `${Engineer.source}` to mention the file (a path) without
   * delegating to the agent (see Source.ts).
   */
  readonly source?: Source;
  /**
   * An implementation Layer for this tag: run the CHARTER once (its
   * bindings, tools, turn and API), publish the resulting
   * namespace as this tag's service. One contract can carry many
   * implementations (`GeneralEngineer = Engineer.make(…)`, a stricter
   * one for prod); an agent with ONE implementation declares it on
   * the class instead and gets {@link Agent.Default}.
   *
   * A persona whose stance never changes writes its charter as a
   * TAGGED TEMPLATE directly on `make` — the static shorthand:
   *
   * ```ts
   * export const ReviewerLive = Reviewer.make`
   *   You review each ${pr} against its originating ${issue}.
   *   Verdict via ${Approve} or changes via ${Comment}.`;
   * ```
   *
   * Otherwise pass a {@link Charter} — one Effect, run at plan time,
   * declaring the agent's bindings, tools and methods together:
   *
   * ```ts
   * export const GeneralEngineer = Engineer.make(
   *   Effect.gen(function* () {
   *     const model = PersistentRef.of("model", () => DEFAULT);  // a declared cell
   *     return { turn: stance, setModel: (id) => PersistentRef.set(model, id) };
   *   }),
   * );
   * ```
   */
  readonly make: {
    /**
     * Static charter shorthand. Splices are still evaluated at render
     * time, every tick — an `Effect` splice may read `AI.Thread`/
     * `AI.Tick` — so their requirements are charged as TURN
     * requirements.
     */
    <const Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Layer.Layer<Self, never, Driver | Exclude<Services<Refs>, TurnServices>>;
    <C extends ImplementationOf<Contract>>(
      charter: C,
    ): Layer.Layer<Self, never, Driver | CharterServices<C>>;
  };
  /**
   * Instances are branded with the agent's name so distinct agents
   * remain distinct types (and therefore distinct tags). The instance
   * shape is the agent namespace: the actor verbs plus `at`.
   */
  new (_: never): AgentService<Contract> & { readonly "~alchemy/Name": Name };
}

/** An agent declared WITH its implementation carries the Layer. */
export interface AgentWithDefault<
  Name extends string,
  Self,
  Contract,
  C,
> extends Agent<Name, Self, Contract> {
  /** The implementation Layer — `Effect.Service`'s `Default` idiom. */
  readonly Default: Layer.Layer<Self, never, Driver | CharterServices<C>>;
}

/** The contract the class ends up with: declared when given, else
 *  inferred from the implementation. */
export type ResolvedContract<Contract, C> = unknown extends Contract
  ? ContractOf<C>
  : Contract;

/** A compile-time guard: an API may not reuse a stub verb's name. */
export type NoReserved<Contract> = [ReservedIn<Contract>] extends [never]
  ? unknown
  : {
      readonly "~alchemy/error": `API method name is reserved: ${ReservedIn<Contract> & string}`;
    };

/**
 * Declare an agent — a NAME, optionally with its CONTRACT and its
 * IMPLEMENTATION.
 *
 * **Inferred.** No contract in the type parameter; the API comes from
 * the implementation:
 *
 * ```ts
 * export class Engineer extends AI.Agent<Engineer>(import.meta)(
 *   "Engineer",
 *   Effect.gen(function* () {
 *     const model = PersistentRef.of("model", () => DEFAULT);
 *     return {
 *       turn: stance,
 *       setModel: (id: ModelId) => PersistentRef.set(model, id),
 *     };
 *   }),
 * ) {}
 * // Engineer.Default : Layer<Engineer, never, Deps>
 * // engineer.at(key).setModel : (id: ModelId) => Effect<void, never, RuntimeContext>
 * ```
 *
 * **Declared.** The contract is the type parameter — the API, an
 * interface of methods; the implementation — inline or via `make` —
 * is checked against it:
 *
 * ```ts
 * export class Engineer extends AI.Agent<Engineer, {
 *   setModel(id: ModelId): Effect.Effect<void>;
 * }>(import.meta)("Engineer", Effect.gen(function* () { … })) {}
 *
 * // or tag only, implementations elsewhere:
 * export class Engineer extends AI.Agent<Engineer, EngineerApi>(import.meta)("Engineer") {}
 * export const GeneralEngineer = Engineer.make(Effect.gen(function* () { … }));
 * ```
 *
 * The charter is ONE Effect, run at plan time (see {@link Charter}):
 * bindings, tools and methods in one scope. Sessions are not
 * constructed — everything that varies per session is state in a
 * declared cell (`PersistentRef.of`), set through a method
 * (`at(key).setModel(id)` before the first `dispatch`), and read by
 * turns, tools and methods from the session frame they run in. No
 * API: return a fragment. An agent whose implementation references its
 * own class (one that spawns itself) is a circular base expression for
 * TypeScript — use the declared form there.
 *
 * `AI.Agent<Self>(import.meta)` additionally records the defining file
 * as `source` (see Source.ts).
 */
export const Agent: {
  <Self, Contract = unknown>(
    meta?: ImportMeta,
  ): {
    /** The tag alone; implementations via `make`. */
    <Name extends string>(
      name: Name,
    ): Agent<Name, Self, Contract> &
      Context.Service<Self, AgentService<Contract>>;
    /** The tag WITH its implementation — `Default` is the Layer. */
    <Name extends string, const C extends ImplementationOf<Contract>>(
      name: Name,
      charter: C & NoReserved<ResolvedContract<Contract, C>>,
    ): AgentWithDefault<Name, Self, ResolvedContract<Contract, C>, C> &
      Context.Service<Self, AgentService<ResolvedContract<Contract, C>>>;
  };
} = ((meta?: ImportMeta) => (name: string, charter?: Charter) =>
  makeTerm("Agent", name, undefined, undefined, meta, charter)) as any;

/** Shared constructor for the tag-bearing terms (Agent, Skill). */
export const makeTerm = (
  kind: "Agent" | "Skill",
  name: string,
  template?: TemplateStringsArray,
  refs?: any[],
  meta?: ImportMeta,
  charter?: Charter,
) => {
  const cls = class extends (Context.Service<any, any>()(
    `alchemy/AI/${kind}/${name}`,
  ) as any) {};
  return Object.assign(cls, {
    "~alchemy/Kind": kind,
    "~alchemy/Name": name,
    ...(meta !== undefined ? { source: makeSource(meta, kind, name) } : {}),
    ...(template !== undefined ? { template, refs } : {}),
    // an agent declared WITH its implementation: `Default` is the Layer
    ...(charter !== undefined ? { Default: layer(cls as any, charter) } : {}),
    // the implementation Layer: `Engineer.make(charter)`, the static
    // tagged-template shorthand `Reviewer.make`…``, or a skill's
    // teaching `Coding.make`…`` — for a Skill the template IS the
    // service payload (prose + granted tools); for an Agent a
    // template lifts to a constant charter
    make: (charterOrTemplate?: any, ...refs: any[]) =>
      kind === "Skill"
        ? layer(cls as any, charterOrTemplate, ...refs)
        : layer(
            cls as any,
            isTemplateStringsArray(charterOrTemplate)
              ? fragment(charterOrTemplate, ...refs)
              : charterOrTemplate,
          ),
  }) as any;
};

const isTemplateStringsArray = (
  value: unknown,
): value is TemplateStringsArray => Array.isArray(value) && "raw" in value;

export const isAgent = (value: unknown): value is Agent<any, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Agent";

// ──────────────── the agent's type-level tool surface ─────────────

/**
 * One tool call that can appear on an agent's transcript, as a type.
 * Mention-is-presence is a runtime law — a charter's toolkit is
 * exactly what its prose splices — and because every `Tool<Self>`
 * class splice rides the Layer's REQUIREMENT channel (its physics
 * must be provided), the same law holds in the type system: a `make`
 * Layer's `RIn` names every class tool the teaching can mention, and
 * {@link ToolNames} / {@link ToolInput} read it LAZILY — nothing is
 * computed or branded at layer construction.
 *
 * Type against the `make` result (the un-provided teaching):
 * `Layer.provide` consumes the requirements the surface is read from,
 * exactly as it consumes them for service coverage.
 *
 * Inline tools (`yield* AI.Tool("x")`…`(impl)`) and dispatch doors
 * carry no tag, so they are RUNTIME-ONLY: invisible to this surface.
 * A tool that wants compiler-checked renderer coverage is a
 * `Tool<Self>` class.
 *
 * ```ts
 * // ui — type-only import (erased at build); the app owns its
 * // registry type:
 * import type { GeneralEngineer } from "../src/Engineer.ts";
 *
 * type Renderers<L> = {
 *   [Name in AI.ToolNames<L> & string]: (
 *     input: AI.ToolInput<L, Name>,
 *   ) => ToolCallView;
 * };
 * // forget one -> compile error naming the missing tool
 * ```
 */
export interface WireTool<Name extends string = string, Input = any> {
  readonly name: Name;
  readonly input: Input;
}

/**
 * The wire-tool union of an agent/skill `make` Layer, derived from its
 * requirement channel: each `Tool<Self>` tag in `RIn` is an instance
 * type extending `Tool<Name, Refs>`, which carries everything the
 * surface needs.
 */
export type WireToolsOf<L> =
  L extends Layer.Layer<any, any, infer RIn>
    ? RIn extends Tool<infer Name extends string, infer Refs>
      ? WireTool<Name, ToolParameters<Refs[number]>>
      : never
    : never;

/** The tool NAMES on an agent layer's wire — a union of literals. */
export type ToolNames<L> = WireToolsOf<L>["name"];

/** The typed input of one named tool on an agent layer's wire. */
export type ToolInput<L, Name extends ToolNames<L>> = Extract<
  WireToolsOf<L>,
  WireTool<Name & string, any>
>["input"];
