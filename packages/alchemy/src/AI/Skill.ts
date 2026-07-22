import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { makeTerm } from "./Agent.ts";

/**
 * The service shape a skill's tag resolves to: the runtime
 * implementations of the skill's tools, keyed by tool name. The
 * DEFAULT Layer (`AI.layer(Coding)`) assembles this record from the
 * individual tool tags; a custom `Layer.effect(Coding, …)` may build
 * the whole bundle's physics inline — the tools need no Layers of
 * their own.
 */
export interface SkillService {
  readonly tools: Record<
    string,
    (input: any) => Effect.Effect<any, any, RuntimeContext>
  >;
}

/**
 * A `Skill` term is a **capability bundle**: prose that teaches a way
 * of working, plus the `Tool`s that work requires — packaged under
 * one name, as a `Context.Service` tag.
 *
 * Referencing a skill in a charter grants ACCESS, not activation —
 * and the access is NOMINAL: the reference contributes the SKILL's
 * tag to the term's `Req` (never the individual tools), so the Layer
 * graph reads the way the prose does. Providing `AI.layer(Coding)`
 * is what pulls the tool tags in as that Layer's own requirements —
 * the bundle is encapsulated behind its name:
 *
 * ```ts
 * export class Coding extends AI.Skill<Coding>()("Coding")`
 * ${Grep} before ${ReadFile}; ${ReadFile} before ${EditFile}.
 * ${Bash} runs the tests — green is the only done.` {}
 *
 * export const CodingLive = AI.layer(Coding);
 * // Layer<Coding, never, Grep | ReadFile | EditFile | Bash>
 * ```
 *
 * At runtime the skill is DORMANT: its prose is not in context and
 * its tools are not in the toolkit until the agent ACTIVATES it (the
 * kernel's intrinsic `skill` tool). Activation returns the skill's
 * prose as the tool result — the documentation enters the
 * conversation exactly when it is needed — and enables the skill's
 * tools for the rest of that run. Deactivation retires them. A
 * spawner may hand skills to a spawned worker PRE-ACTIVATED: the
 * prose joins the worker's instructions, the tools its toolkit.
 */
export interface Skill<
  Name extends string = string,
  Refs extends any[] = any[],
  Self = unknown,
> {
  "~alchemy/Kind": "Skill";
  "~alchemy/Name": Name;
  template: TemplateStringsArray;
  refs: Refs;
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
  new (_: never): SkillService & { readonly "~alchemy/Name": Name };
}

export const Skill: {
  <Self>(): {
    <const Name extends string>(
      name: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Skill<Name, Refs, Self> & Context.Service<Self, SkillService>;
    };
  };
} = (() =>
  (name: string) =>
  (template: TemplateStringsArray, ...refs: any[]) =>
    makeTerm("Skill", name, template, refs)) as any;

export const isSkill = (value: unknown): value is Skill<string, any[], any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Skill";
