import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { DispatchTool } from "./Dispatch.ts";
import {
  layer,
  type Charter,
  type CharterServices,
  type Driver,
  type TurnServices,
} from "./Driver.ts";
import { fragment, type Fragment, type Services } from "./Fragment.ts";
import type { Tool, ToolImpl, ToolParameters } from "./Tool.ts";

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
}

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
export interface Agent<Name extends string = string, Self = unknown> {
  "~alchemy/Kind": "Agent";
  "~alchemy/Name": Name;
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
  /**
   * The driver-default implementation Layer: interpret the CHARTER
   * (init → turn), publish the resulting actor verbs as this tag's
   * service.
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
   * A dynamic persona passes the full init → turn charter:
   *
   * ```ts
   * export const EngineerLive = Engineer.make(Effect.gen(function* () {
   *   const done = yield* Ref.make(false);        // init: Refs, bindings for tools
   *   return Effect.gen(function* () {            // turn: every sampling
   *     const { count } = yield* AI.Tick;         // runtime facts live here
   *     return yield* AI.fragment`…`;
   *   });
   * }));
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
    ): WiredLayer<
      Self,
      Driver | Exclude<Services<Refs>, TurnServices>,
      FragmentTools<Refs>
    >;
    <C extends Charter>(
      charter: C,
    ): WiredLayer<Self, Driver | CharterServices<C>, CharterTools<C>>;
  };
  /**
   * Instances are branded with the agent's name so distinct agents
   * remain distinct types (and therefore distinct tags). The instance
   * shape is always the one agent interface: the actor verbs.
   */
  new (_: never): Actor & { readonly "~alchemy/Name": Name };
}

export const Agent: {
  <Self>(): {
    <Name extends string>(
      name: Name,
    ): Agent<Name, Self> & Context.Service<Self, Actor>;
  };
} = (() => (name: string) => makeTerm("Agent", name)) as any;

/** Shared constructor for the tag-bearing terms (Agent, Skill). */
export const makeTerm = (
  kind: "Agent" | "Skill",
  name: string,
  template?: TemplateStringsArray,
  refs?: any[],
) => {
  const cls = class extends (Context.Service<any, any>()(
    `alchemy/AI/${kind}/${name}`,
  ) as any) {};
  return Object.assign(cls, {
    "~alchemy/Kind": kind,
    "~alchemy/Name": name,
    ...(template !== undefined ? { template, refs } : {}),
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
 * exactly what its prose splices — and because {@link Fragment}
 * retains its refs' types, the same law holds in the type system:
 * {@link CharterTools} extracts every tool a charter can mention, and
 * a UI can prove renderer coverage against it the same way
 * `Layer.provide` proves service coverage.
 *
 * The core exposes only the FACTS — {@link WireTool},
 * {@link ToolNames}, {@link ToolInput}, the {@link WiredLayer} brand.
 * What a consumer builds on them (a renderer registry, a
 * wire-protocol codec, a docs generator) is userland:
 *
 * ```ts
 * // ui — type-only import (erased at build); the app owns its
 * // registry type:
 * import type { EngineerLive } from "../src/Engineer.ts";
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
 * The wire contribution of ONE splice:
 *
 * - an inline {@link ToolImpl} contributes its tool's name + params;
 * - a `Tool<Self>` class splice contributes the same (the tag rides
 *   the requirement channel separately — see `Services`);
 * - a {@link DispatchTool} (door) contributes its name + params;
 * - a nested fragment (raw or effect-valued — nested `AI.fragment`, a
 *   component's turn value) contributes ITS tools, recursively, so
 *   conditional branches accumulate: every tool any branch could
 *   mention is on the wire type, whether or not this tick renders it;
 * - everything else (parameters, agents, skills, plain values)
 *   contributes nothing. A skill's tools are encapsulated behind the
 *   skill's own layer, mirroring `Services` — cover them with a
 *   registry for the skill pack, composed alongside the agent's.
 */
export type RefWireTools<R> =
  R extends ToolImpl<infer T, any, any>
    ? T extends Tool<infer Name, infer Refs>
      ? WireTool<Name, ToolParameters<Refs[number]>>
      : never
    : // a Tool<Self> CLASS splice: matched on its identifying members,
      // not the Tool interface itself — `class X extends AI.Tool<X>()(…)`
      // yields a constructor type that drops the interface's call
      // signatures, so a full `extends Tool<…>` never matches a class
      R extends {
          "~alchemy/Kind": "Tool";
          "~alchemy/Name": infer Name extends string;
          refs: infer Refs extends any[];
        }
      ? WireTool<Name, ToolParameters<Refs[number]>>
      : R extends DispatchTool<infer Name, infer Refs>
        ? WireTool<Name, ToolParameters<Refs[number]>>
        : R extends Fragment<infer Refs>
          ? FragmentTools<Refs>
          : R extends Effect.Effect<infer A, any, any>
            ? A extends Fragment<infer Refs>
              ? FragmentTools<Refs>
              : never
            : never;

/** Folds a fragment's splices into its wire-tool union. */
export type FragmentTools<Refs extends ReadonlyArray<unknown>> =
  Refs[number] extends infer A ? RefWireTools<A> : never;

/**
 * The wire-tool union of a full charter (init → turn): tools mentioned
 * by a static fragment, a TURN effect's fragment, or a `TurnFn`'s
 * fragment. Distributes over unions, so a charter whose init returns
 * different turns on different branches accumulates all of them.
 */
export type CharterTools<C> =
  C extends Effect.Effect<infer A, any, any> ? TurnTools<A> : never;

type TurnTools<A> =
  A extends Fragment<infer Refs>
    ? FragmentTools<Refs>
    : A extends Effect.Effect<infer F, any, any>
      ? F extends Fragment<infer Refs>
        ? FragmentTools<Refs>
        : never
      : A extends (input: never) => Effect.Effect<infer F, any, any>
        ? F extends Fragment<infer Refs>
          ? FragmentTools<Refs>
          : never
        : never;

/**
 * A Layer branded (phantom — nothing exists at runtime) with the wire
 * surface of the agent it implements. `Agent.make` returns this, so
 * `typeof SomeAgentLive` is all a UI needs to know every tool that can
 * appear on the transcript.
 */
export interface WiredLayer<
  ROut,
  RIn,
  Tools extends WireTool,
> extends Layer.Layer<ROut, never, RIn> {
  readonly "~alchemy/WireTools"?: Tools;
}

/** The wire-tool union carried by a {@link WiredLayer}. */
export type WireToolsOf<L> = L extends {
  readonly "~alchemy/WireTools"?: (infer T) | undefined;
}
  ? Extract<T, WireTool>
  : never;

/** The tool NAMES on an agent layer's wire — a union of literals. */
export type ToolNames<L> = WireToolsOf<L>["name"];

/** The typed input of one named tool on an agent layer's wire. */
export type ToolInput<L, Name extends ToolNames<L>> = Extract<
  WireToolsOf<L>,
  WireTool<Name & string, any>
>["input"];
