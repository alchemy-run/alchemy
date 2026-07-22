import * as Context from "effect/Context";
import type { Actor } from "./Actor.ts";
import type { Accepts } from "./Event.ts";
import type { Services } from "./Services.ts";

/**
 * An `Agent` term is a callable persona: prose that hires
 * capabilities, as a tagged template whose interpolations declare the
 * tools, skills, and fellow agents it may use. Like all terms it is
 * pure data — behavior comes from an interpreter (a {@link Kernel}
 * implementation). At runtime an agent is a minimal event-driven,
 * asynchronous entity: a mailbox, a serial run loop, actions out.
 *
 * Every agent's tag resolves to the SAME interface — the
 * {@link Actor} verbs — because agents exist to be called:
 * an owner hands the Engineer a ready issue (`dispatch`) and awaits
 * the pull request. A term whose public surface should be a
 * domain-specific, deterministic interface instead is a
 * {@link Process}, not an agent.
 *
 * The `<Self>()` form makes the agent a `Context.Service` **tag**:
 *
 * - Interpolating `${Engineer}` in another charter contributes the tag
 *   `Engineer` to that charter's `Req` — not the agent's tools.
 *   Transitivity lives in Layer composition: each agent gets its own
 *   capability provisioning
 *   (`AI.layer(Engineer).pipe(Layer.provide(BashDevBox))` vs
 *   `AI.layer(Judge).pipe(Layer.provide(BashReadOnly))` — one
 *   contract, different physics, side by side in one runtime).
 * - Yielding `Engineer` in `Effect.gen` resolves the live service from
 *   context.
 *
 * Capability denial by omission: a charter that never interpolates
 * `${Approve}` has no `Approve` anywhere in its Layer graph's
 * requirements; no Layer can grant it merge authority. Constitutional
 * constraints are enforced by the type system, not by prose.
 */
export interface Agent<
  Req = never,
  Name extends string = string,
  Refs extends any[] = any[],
  Self = unknown,
> {
  "~alchemy/Kind": "Agent";
  "~alchemy/Name": Name;
  template: TemplateStringsArray;
  refs: Refs;
  /** Phantom: the requirements of this agent's implementation Layer. */
  "~alchemy/Req": Req;
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
  /**
   * Instances are branded with the agent's name so distinct agents
   * remain distinct types (and therefore distinct tags). The instance
   * shape is always the one agent interface: the actor verbs, with
   * the input alphabet derived from the charter's event splices.
   */
  new (_: never): Actor<Accepts<Refs>> & { readonly "~alchemy/Name": Name };
}

export const Agent: {
  <Self>(): {
    <Name extends string>(
      name: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Agent<Services<Refs>, Name, Refs, Self> &
        Context.Service<Self, Actor<Accepts<Refs>>>;
    };
  };
  <Name extends string>(
    name: Name,
  ): {
    <const Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Agent<Services<Refs>, Name, Refs>;
  };
} = ((name?: string) =>
  name
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeTerm("Agent", name, template, refs)
    : (name: string) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeTerm("Agent", name, template, refs)) as any;

/** Shared constructor for the tag-bearing terms (Agent, Process, Skill). */
export const makeTerm = (
  kind: "Agent" | "Process" | "Skill",
  name: string,
  template: TemplateStringsArray,
  refs: any[],
) =>
  Object.assign(
    class extends (Context.Service<any, any>()(
      `alchemy/AI/${kind}/${name}`,
    ) as any) {},
    {
      "~alchemy/Kind": kind,
      "~alchemy/Name": name,
      refs,
      template,
    },
  ) as any;

export const isAgent = (value: unknown): value is Agent<any, any, any[], any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Agent";
