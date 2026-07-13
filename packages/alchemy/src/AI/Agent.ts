import * as Context from "effect/Context";
import type { ProcessService } from "./Process.ts";
import type { Services } from "./Services.ts";
import type { HaltOutcome } from "./Step.ts";

/**
 * An `Agent` term is prose that hires tools: a tagged template whose
 * interpolations declare the tools (and parameters) the agent may use.
 * Like all terms it is pure data — behavior comes from interpreters.
 *
 * Agent is one of the two **process terms** (with `Process` — the
 * `InterpretableTerm` union): the only term class the Kernel interprets,
 * each interpretation acquiring a ring (one serial admission loop) of
 * its own. The capability terms it interpolates (`Tool`, `Parameter`)
 * are compiled into its turns — they never get rings.
 *
 * The `<Self>()` form makes the agent a `Context.Service` **tag**, so:
 *
 * - Interpolating `${Engineer}` in a Process charter contributes the tag
 *   `Engineer` to the loop's `Req` — not the agent's tools. Transitivity
 *   moves from type-level bubbling to Layer composition.
 * - The agent's implementation is a Layer: the kernel-derived default
 *   (`AI.layer(Engineer)`, requiring `Kernel` + the agent's tools) or any
 *   custom `Layer.effect(Engineer, …)`.
 * - Each agent gets its own tool provisioning:
 *   `AI.layer(Engineer).pipe(Layer.provide(BashDevBox))` vs
 *   `AI.layer(Judge).pipe(Layer.provide(BashReadOnly))` — two agents, one
 *   `Bash` contract, different physics, side by side in one runtime.
 *
 * `Req` (the fourth parameter) is the agent's *construction* requirement —
 * the union of its interpolated tool tags, i.e. what its Layer must be
 * provided with. It is carried as a phantom (`"~alchemy/Req"`) and consumed
 * by `AI.layer` / `Kernel.agent`.
 */
export interface Agent<
  Name extends string = string,
  Refs extends any[] = any[],
  Self = unknown,
  Req = never,
> {
  "~alchemy/Kind": "Agent";
  "~alchemy/Name": Name;
  template: TemplateStringsArray;
  refs: Refs;
  /** Phantom: the requirements of this agent's implementation Layer. */
  "~alchemy/Req": Req;
  /**
   * Instances are branded with the agent's name so that distinct agents
   * remain distinct *types* (structural typing would otherwise collapse
   * every `Self` to the same `AgentService` shape, and with it every tag).
   */
  new (_: never): AgentService & { readonly "~alchemy/Name": Name };
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
}

/**
 * The live handle an `Agent` term interprets into — the same
 * {@link ProcessService} shape a Process produces, with the channels
 * supplied by **kernel defaults** instead of refs (see
 * designs/ai/reports/agent-loop-algebra.md):
 *
 * - inbox   = the send/dispatch mailbox (each message is a work item)
 * - halt    = "model returned no tool calls" (kernel policy — never a
 *   term: the execution ring's exit is model-behavior lore the charter
 *   may not override)
 * - fold    = append to the carried transcript
 * - `Out`   = the turn's final message (an opaque kernel type in
 *   Phase 1; refined in Phase 2)
 * - `Err = never` is a theorem, not a default: tool errors are
 *   model-visible results the agent reacts to; harness failures surface
 *   as `KernelError` at interpretation time.
 *
 * There is no `session` parameter: a run is keyed by `(term, work item)`
 * — world identity (the Discord thread, the GitHub issue) rides in `In`.
 * An interactive dispatch with no world identity gets a kernel-minted
 * one-shot key.
 */
export interface AgentService<
  In = unknown,
  Out = HaltOutcome,
> extends ProcessService<Out, In, never> {}

export const Agent: {
  <Self>(): {
    <Name extends string>(
      id: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Agent<Name, Refs, Self, Services<Refs>> &
        Context.Service<Self, AgentService>;
    };
  };
  <Name extends string>(
    id: Name,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Agent<Name, Refs, unknown, Services<Refs>>;
  };
} = ((name?: string) =>
  name
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeAgent(name, template, refs)
    : (name: string) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeAgent(name, template, refs)) as any;

const makeAgent = (name: string, template: TemplateStringsArray, refs: any[]) =>
  Object.assign(
    class extends (Context.Service<any, AgentService>()(
      `alchemy/AI/Agent/${name}`,
    ) as any) {},
    {
      "~alchemy/Kind": "Agent",
      "~alchemy/Name": name,
      refs,
      template,
    },
  ) as any;

export const isAgent = (value: unknown): value is Agent =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Agent";
