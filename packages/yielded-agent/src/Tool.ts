import { toolkit as toToolkit } from "@alchemy.run/ai/Toolkit";

export {
  flattenTools,
  toEffectTool,
  type AnyTool,
  type EffectTool,
  type ToolRef,
  type ToolRequirements,
} from "@alchemy.run/ai/Toolkit";

/**
 * The Effect AI toolkit of some `AI.Tool`s, for a Yielded agent's
 * `toolkit`. The tools' implementations stay where they are: Layers (or
 * inline handlers) the harness resolves, so an agent definition needs
 * nothing provided.
 *
 * **Example:** An agent that looks codes up with an `AI.Tool`
 * ```typescript
 * export const Assistant = Agent.make("assistant", {
 *   input: Schema.String,
 *   output: Output.text(Schema.String),
 *   instructions: "Use your tools whenever they apply.",
 *   toolkit: YieldedAgent.toolkit(LookupCode),
 * });
 * ```
 */
export const toolkit = toToolkit;
