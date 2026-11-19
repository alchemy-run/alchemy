import { Sandbox } from "@alchemy.run/ai/Sandbox";
import {
  callTool,
  parametersJsonSchema,
  ToolCall,
  toolKind,
  type AnyTool as AiTool_,
  type InlineTool,
  type SandboxesFor,
  type ToolClass,
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
export type ToolServices = Sandbox | ToolCall | RuntimeContext;

const PiToolTypeId = "~alchemy/Pi/Tool" as const;

/** One of Pi's own tools (`read`, `bash`, …), used as is. */
export interface BuiltinTool<Name extends string = string, Requires = never> {
  readonly [PiToolTypeId]: "builtin";
  readonly toolName: Name;
  readonly registration: ToolRegistration;
  /** Phantom: what yielding the harness that lists this tool requires. */
  readonly "~requires"?: Requires;
}

/** Several tools listed as one. */
export interface ToolGroup<Tools extends ReadonlyArray<AnyTool> = ReadonlyArray<AnyTool>> {
  readonly [PiToolTypeId]: "group";
  readonly tools: Tools;
}

/** Anything a Pi harness lists as a tool: an `AI.Tool`, one of Pi's own, or a group. */
export type AnyTool = AiTool_ | BuiltinTool<string, any> | ToolGroup;

type OwnRequirements<T> =
  T extends ToolClass<any, any, any, infer Requires>
    ? Requires
    : T extends InlineTool<any, any, infer Uses>
      ? SandboxesFor<Uses>
      : T extends BuiltinTool<any, infer Requires>
        ? Requires
        : never;

/** What listing `T` on a harness requires to be provided. */
export type ToolRequirements<T> =
  T extends ToolGroup<infer Tools> ? OwnRequirements<Tools[number]> : OwnRequirements<T>;

/** A tool that can be enabled on a conversation, by reference. */
export type ToolRef = AiTool_ | BuiltinTool<string, any>;

/** How a listed tool was declared. */
export const kindOf = (tool: AnyTool): "class" | "inline" | "builtin" | "group" =>
  PiToolTypeId in tool ? tool[PiToolTypeId] : toolKind(tool);

/** Every tool a list names, groups flattened. */
export const flattenTools = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolRef> =>
  tools.flatMap((tool) =>
    kindOf(tool) === "group" ? flattenTools((tool as ToolGroup).tools) : [tool as ToolRef],
  );

/** Group tools so one name lists them all. */
export const group = <const Tools extends ReadonlyArray<AnyTool>>(
  ...tools: Tools
): ToolGroup<Tools> => ({
  [PiToolTypeId]: "group",
  tools,
});

/** Wrap one of Pi's own tool registrations. */
export const builtin = <Name extends string, Requires = never>(
  registration: ToolRegistration & { name: Name },
): BuiltinTool<Name, Requires> => ({
  [PiToolTypeId]: "builtin",
  toolName: registration.name,
  registration,
});

const jsonSchemaOf = (schema: Schema.Top): object =>
  AiTool.getJsonSchemaFromSchema(schema) as object;

/** Runs a tool's Effect where the harness was yielded. */
export type RunTool = <A, E>(
  effect: Effect.Effect<A, E, ToolServices>,
  services: Context.Context<Sandbox | ToolCall>,
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
): ToolRegistration => {
  // A tool that returns nothing has no value for a program to read.
  const returns = spec.success.ast._tag !== "Void";
  return {
    name,
    description: spec.description,
    parameters: parametersJsonSchema(spec),
    ...(returns ? { structuredOutputSchema: jsonSchemaOf(spec.success) } : {}),
    ...(spec.replay ? { replay: spec.replay } : {}),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const services = Context.make(ToolCall, {
        conversationId: String(api.conversationId),
        callId: api.callId,
      }).pipe(Context.add(Sandbox, makeSandbox(requireEnv(api.env))));
      const exit = await run(callTool(spec, handler, args), services, context.abortSignal);
      // A defect or interruption: Pi turns a throw into the model's error result.
      if (!Exit.isSuccess(exit)) throw new Error(messageOf(exit.cause.pipe(Cause.squash)));
      const result = exit.value;
      return {
        ...(result.isError ? { isError: true } : {}),
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
