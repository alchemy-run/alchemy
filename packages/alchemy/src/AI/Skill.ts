import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { makeTerm } from "./Agent.ts";
import type { Services } from "./Fragment.ts";
import type * as Layer from "effect/Layer";

/**
 * The service shape a skill's tag resolves to: the skill's TEACHING
 * (the tagged template its Layer was made with — prose plus tool
 * splices) and the runtime implementations of the tools it grants,
 * keyed by tool name. The IMPLEMENTATION carries the prose: one skill
 * contract can ship different teachings (and different tools) per
 * environment — a local `Coding.make` over the FS toolbox beside a
 * DevBox-flavored one, side by side in one runtime.
 */
export interface SkillService {
  /** The teaching — rendered when the skill is activated. */
  readonly template: TemplateStringsArray;
  /** The template's splices: the tools this implementation grants. */
  readonly refs: ReadonlyArray<unknown>;
  /** Runtime physics for the granted tools, keyed by tool name. */
  readonly tools: Record<
    string,
    (input: any) => Effect.Effect<any, any, RuntimeContext>
  >;
}

/**
 * The TEACHING a `Skill.make`…`` Layer was made from — its template and
 * splices, types retained — carried on the Layer as static data. The
 * Layer is the runtime skill; the teaching is the same text as a
 * document: render it ({@link render} in DriverCore) to publish a
 * skill's doctrine as markdown (an `AGENTS.md`, a page) from the one
 * source the agents activate.
 */
export interface Teaching<
  Refs extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
> {
  readonly template: TemplateStringsArray;
  readonly refs: Refs;
}

/**
 * The Layer `Skill.make`…`` returns: the skill's tag out, the spliced
 * tools' tags in, AND the {@link Teaching} it was made from.
 */
export type SkillLayer<Self, Refs extends any[]> = Layer.Layer<
  Self,
  never,
  Services<Refs>
> &
  Teaching<Refs>;

/**
 * A `Skill` term is a **capability bundle**: prose that teaches a way
 * of working, plus the `Tool`s that work requires — packaged under
 * one NAME, as a bare `Context.Service` tag. The declaration carries
 * nothing else; the teaching lives on the Layer:
 *
 * ```ts
 * export class Coding extends AI.Skill<Coding>()("Coding") {}
 *
 * export const CodingLive = Coding.make`
 * ${Grep} before ${ReadFile}; ${ReadFile} before ${EditFile}.
 * ${Bash} runs the tests — green is the only done.`;
 * // Layer<Coding, never, Grep | ReadFile | EditFile | Bash>
 * ```
 *
 * Referencing a skill in a charter grants ACCESS, not activation —
 * and the access is NOMINAL: the reference contributes the SKILL's
 * tag to the term's `Req` (never the individual tools), so the Layer
 * graph reads the way the prose does. Providing the `make` Layer is
 * what pulls the tool tags in as that Layer's own requirements — the
 * bundle is encapsulated behind its name, and two implementations of
 * the same contract may teach different prose over different tools.
 * A prose-only skill (a doctrine with no affordances of its own)
 * is simply a template with no tool splices.
 *
 * At runtime the skill is DORMANT: its prose is not in context and
 * its tools are not in the toolkit until the agent ACTIVATES it (the
 * driver's intrinsic `skill` tool). Activation returns the skill's
 * prose as the tool result — the documentation enters the
 * conversation exactly when it is needed — and enables the skill's
 * tools for the rest of that session. Deactivation retires them. A
 * spawner may hand skills to a spawned worker PRE-ACTIVATED: the
 * prose joins the worker's instructions, the tools its toolkit.
 */
export interface Skill<Name extends string = string, Self = unknown> {
  "~alchemy/Kind": "Skill";
  "~alchemy/Name": Name;
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
  /**
   * The implementation Layer: the skill's tag out, the template's
   * spliced TOOLS' tags in (a custom `Layer.effect(Coding, …)` may
   * instead build the whole bundle's physics inline).
   *
   * The requirement channel IS the wire surface — a skill's tools are
   * encapsulated behind its tag (they never surface on a HOST agent's
   * type), so the skill's own `make` result is what a UI checks
   * renderer coverage against (via `AI.ToolNames` / `AI.ToolInput`).
   * Note `Layer.provide` (binding the physics) consumes those
   * requirements — type renderer packs off the `make` result, the
   * teaching itself.
   */
  readonly make: <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => SkillLayer<Self, Refs>;
  new (_: never): SkillService & { readonly "~alchemy/Name": Name };
}

export const Skill: {
  <Self>(): {
    <const Name extends string>(
      name: Name,
    ): Skill<Name, Self> & Context.Service<Self, SkillService>;
  };
} = (() => (name: string) => makeTerm("Skill", name)) as any;

export const isSkill = (value: unknown): value is Skill<string, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Skill";
