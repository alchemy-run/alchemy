import type { Sandboxes } from "@alchemy.run/ai/Sandbox";
import {
  isToolGroup,
  type InlineTool,
  type SandboxesFor,
  type ToolClass,
  type ToolGroup,
  type ToolSpec,
} from "@alchemy.run/ai/Tool";
import { Tool as AiTool, Toolkit } from "effect/ai";
import type * as Schema from "effect/Schema";

/** A tool a Yielded agent can call: an `AI.Tool` class or an inline `AI.Tool`. */
export type ToolRef = ToolClass<any, string, any, any> | InlineTool<string, any, any>;

/** Anything listed as a tool: one tool, or a group of them. */
export type AnyTool = ToolRef | ToolGroup<ReadonlyArray<ToolRef>>;

type Flatten<T> = T extends ToolGroup<infer Tools> ? Tools[number] : T;

/** What listing `T` in a harness's `tools` requires to be provided. */
export type ToolRequirements<T> =
  Flatten<T> extends infer Tool
    ? Tool extends ToolClass<any, any, any, infer Requires>
      ? Requires
      : Tool extends InlineTool<any, any, infer Uses>
        ? SandboxesFor<Uses>
        : never
    : never;

type FailureSchema<Spec extends ToolSpec> = Spec extends {
  readonly failure: infer F extends Schema.Top;
}
  ? F
  : typeof Schema.Never;

/**
 * The Effect AI tool an `AI.Tool` declares: the same name, parameters,
 * success and failure. A declared failure is returned to the model, as on
 * every harness, instead of failing the Run.
 */
export type EffectTool<T> = T extends {
  readonly toolName: infer Name extends string;
  readonly spec: infer Spec extends ToolSpec;
}
  ? AiTool.Tool<
      Name,
      {
        readonly parameters: Spec["parameters"];
        readonly success: Spec["success"];
        readonly failure: FailureSchema<Spec>;
        readonly failureMode: "return";
      },
      never
    >
  : never;

type EffectTools<Tools extends ReadonlyArray<AnyTool>> = {
  readonly [Name in Flatten<Tools[number]>["toolName"]]: EffectTool<
    Extract<Flatten<Tools[number]>, { readonly toolName: Name }>
  >;
};

/** Every tool a list names, groups flattened. */
export const flattenTools = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolRef> =>
  tools.flatMap((tool) => (isToolGroup(tool) ? flattenTools(tool.tools as never) : [tool]));

/** One `AI.Tool` as the Effect AI tool Yielded runs. */
export const toEffectTool = (tool: ToolRef): AiTool.Any =>
  AiTool.make(tool.toolName, {
    description: tool.spec.description,
    parameters: tool.spec.parameters,
    success: tool.spec.success,
    ...(tool.spec.failure === undefined ? {} : { failure: tool.spec.failure }),
    failureMode: "return",
  }) as AiTool.Any;

/**
 * The Effect AI toolkit of some `AI.Tool`s, for a Yielded agent's
 * `toolkit`. The tools' implementations stay where they are: Layers (or
 * inline handlers) the harness resolves, so an agent definition needs
 * nothing provided.
 *
 * **Example:** An agent that adds with an `AI.Tool`
 * ```typescript
 * export const Calculator = Agent.make("calculator", {
 *   input: Schema.String,
 *   output: Schema.Struct({ answer: Schema.Number }),
 *   instructions: "Answer with the add tool.",
 *   toolkit: YieldedAgent.toolkit(Add),
 * });
 * ```
 */
export const toolkit = <const Tools extends ReadonlyArray<AnyTool>>(
  ...tools: Tools
): Toolkit.Toolkit<EffectTools<Tools>> =>
  Toolkit.make(...flattenTools(tools).map(toEffectTool)) as unknown as Toolkit.Toolkit<
    EffectTools<Tools>
  >;

/** Whether any listed tool needs a sandbox, as far as its type says. */
export type NeedsSandboxes<Tools extends ReadonlyArray<AnyTool>> = Extract<
  ToolRequirements<Tools[number]>,
  Sandboxes
>;
