import * as Context from "effect/Context";
import type * as Layer from "effect/Layer";
import type { Actor } from "./Actor.ts";
import {
  layer,
  type Charter,
  type CharterServices,
  type Kernel,
  type TurnServices,
} from "./Kernel.ts";
import { prose } from "./Prose.ts";
import type { Services } from "./Services.ts";

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
   * The kernel-default implementation Layer: interpret the CHARTER
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
   *     return yield* AI.prose`…`;
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
    ): Layer.Layer<Self, never, Kernel | Exclude<Services<Refs>, TurnServices>>;
    <C extends Charter>(
      charter: C,
    ): Layer.Layer<Self, never, Kernel | CharterServices<C>>;
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
              ? prose(charterOrTemplate, ...refs)
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
