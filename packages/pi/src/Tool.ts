import { Sandbox, type Sandboxes } from "@alchemy.run/ai/Sandbox";
import { StateStore } from "@alchemy.run/ai/State";
import {
  callTool,
  isToolGroup,
  isToolTag,
  parametersJsonSchema,
  ToolCall,
  toolKind,
  type AnyTool as AiTool_,
  type AnyToolTag,
  type InlineTool,
  type SandboxesFor,
  type ToolClass,
  type ToolGroup,
  type ToolTagClass,
  type ToolHandler,
  type ToolSpec,
} from "@alchemy.run/ai/Tool";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Tool as AiTool } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { makeSandbox } from "./Env.ts";
import { messageOf } from "./internal/promise.ts";

/** The services every tool handler on a Pi harness may use. */
export type ToolServices = Sandbox | ToolCall | StateStore | RuntimeContext;

/** Anything a Pi harness lists as a tool: an `AI.Tool`, a tool tag (`AI.Bash`), or a group. */
export type AnyTool = ToolRef | ToolGroup<ReadonlyArray<ToolRef>>;

type OwnRequirements<T> =
  T extends ToolTagClass<infer Self, any>
    ? Self
    : T extends ToolClass<any, any, any, infer Requires>
      ? Requires
      : T extends InlineTool<any, any, infer Uses>
        ? SandboxesFor<Uses>
        : never;

/** What listing `T` on a harness requires to be provided. */
export type ToolRequirements<T> =
  T extends ToolGroup<infer Tools> ? OwnRequirements<Tools[number]> : OwnRequirements<T>;

/** A tool that can be enabled on a conversation, by reference. */
export type ToolRef = AiTool_ | AnyToolTag;

/** How a listed tool was declared. */
export const kindOf = (tool: AnyTool): "class" | "inline" | "tag" | "group" =>
  isToolGroup(tool) ? "group" : isToolTag(tool) ? "tag" : toolKind(tool);

/** Every tool a list names, groups flattened. */
export const flattenTools = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolRef> =>
  tools.flatMap((tool) => (isToolGroup(tool) ? flattenTools(tool.tools as never) : [tool]));

/** The engine name Pi's own tools are provided under (`AI.Bash.native`). */
export const ENGINE = "pi";

/** What a Layer for one of Pi's own tools provides. */
export interface NativeTool {
  readonly registration: ToolRegistration;
  /** Where the tool finds files and a shell. */
  readonly sandboxes: Sandboxes["Service"];
}

const jsonSchemaOf = (schema: Schema.Top): object =>
  AiTool.getJsonSchemaFromSchema(schema) as object;

/**
 * The registration field holding the JSON Schema of a tool's declared
 * `failure`, which code mode renders into the tool's declaration.
 */
export const FAILURE_SCHEMA = "~alchemy/failureSchema";

const declaresFailure = (spec: ToolSpec): spec is ToolSpec & { failure: Schema.Top } =>
  spec.failure !== undefined && spec.failure.ast._tag !== "Never";

/** Runs a tool's Effect where the harness was yielded. */
export type RunTool = <A, E>(
  effect: Effect.Effect<A, E, ToolServices>,
  services: Context.Context<Sandbox | ToolCall | StateStore>,
  signal: AbortSignal | undefined,
) => Promise<Exit.Exit<A, E>>;

/**
 * Compile a tool and its handler into the Pi registration the harness
 * installs. The call itself runs as on every harness (`callTool`); its
 * result becomes Pi's output and `structuredOutput`.
 */
export const toRegistration = (
  name: string,
  spec: ToolSpec,
  handler: ToolHandler<ToolSpec>,
  run: RunTool,
  /** The state of a conversation, by its id. */
  stateOf: (conversationId: string) => StateStore["Service"],
): ToolRegistration => {
  // A tool that returns nothing has no value for a program to read.
  const returns = spec.success.ast._tag !== "Void";
  return {
    name,
    description: spec.description,
    parameters: parametersJsonSchema(spec),
    ...(returns ? { structuredOutputSchema: jsonSchemaOf(spec.success) } : {}),
    ...(declaresFailure(spec) ? { [FAILURE_SCHEMA]: jsonSchemaOf(spec.failure) } : {}),
    ...(spec.replay ? { replay: spec.replay } : {}),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const services = Context.make(ToolCall, {
        conversationId: String(api.conversationId),
        callId: api.callId,
      }).pipe(
        Context.add(Sandbox, makeSandbox(requireEnv(api.env))),
        Context.add(StateStore, stateOf(String(api.conversationId))),
      );
      const exit = await run(callTool(spec, handler, args), services, context.abortSignal);
      // A defect or interruption: Pi turns a throw into the model's error result.
      if (!Exit.isSuccess(exit)) throw new Error(messageOf(exit.cause.pipe(Cause.squash)));
      const result = exit.value;
      // A declared failure has no structured value: a program would read its
      // fields as the success type. Pi hands programs the failure's text (its
      // encoded fields) as the error, and code mode rebuilds it by `_tag`.
      return result.isError
        ? { isError: true, output: [{ type: "text", text: result.text }] }
        : {
            output: [{ type: "text", text: result.text }],
            ...(returns ? { structuredOutput: result.structured as JsonValue } : {}),
          };
    },
  } as ToolRegistration;
};

const missingEnv = new Proxy(
  {},
  {
    get: (_target, property) => {
      if (property === "then") return undefined;
      throw new Error(
        `This harness was given no AI.Sandboxes: the tool cannot use AI.Sandbox (${String(property)}).`,
      );
    },
  },
);

const requireEnv = (env: ToolExecutionApi["env"]) =>
  (env ?? missingEnv) as NonNullable<ToolExecutionApi["env"]>;
