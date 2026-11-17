import type { Sandbox } from "@alchemy.run/ai/Sandbox";
import {
  toolConstructor,
  ToolCall,
  toolKind,
  type AnyTool as AiTool_,
  type InlineTool,
  type ToolClass,
  type ToolConstructor,
  type ToolHandler,
  type ToolSpec as AiToolSpec,
} from "@alchemy.run/ai/Tool";
import type { JsonValue } from "@earendil-works/chord";
import type {
  JsonObject,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Tool as AiTool } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Env, makeEnv } from "./Env.ts";
import { messageOf } from "./internal/promise.ts";

/** What a Pi tool says it takes and returns: an `AI.Tool`'s spec, and Pi's own options. */
export interface ToolSpec extends AiToolSpec {
  /** Run this tool's calls one at a time, or alongside the round's others. */
  readonly executionMode?: "parallel" | "sequential";
  /** Hidden from the model until a tool search loads it. */
  readonly deferred?: true;
  /** Who may call it: the model, other tools (code mode), or both. */
  readonly callers?: ReadonlyArray<"model" | "tools">;
}

/** The services every tool handler on a Pi harness may use. */
export type ToolServices = Env | ToolCall | RuntimeContext;

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

/** Anything a Pi harness lists as a tool: an `AI.Tool`, a `Pi.Tool`, one of Pi's own, or a group. */
export type AnyTool = AiTool_ | BuiltinTool<string, any> | ToolGroup;

/** A handler that may use `Pi.Env` needs somewhere for files and a shell. */
type EnvRequirement<Services> = [Services] extends [never] ? never : Sandbox;

type OwnRequirements<T> =
  T extends ToolClass<any, any, any, infer Requires, infer Services>
    ? Requires | EnvRequirement<Services>
    : T extends InlineTool<any, any, infer Services>
      ? EnvRequirement<Services>
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

/**
 * Declare a tool that uses what only Pi gives a call: the conversation's
 * files and shell (`Pi.Env`), and Pi's own options. Listing one requires
 * an `AI.Sandbox`, as the coding tools do. A tool that needs neither is an
 * `AI.Tool`, which runs on any harness.
 *
 * **Example:** A tool that runs a command in the conversation's sandbox
 * ```typescript
 * export class RunTests extends Pi.Tool<RunTests>()("run_tests", {
 *   description: "Run the test suite and report failures.",
 *   parameters: Schema.Struct({ filter: Schema.optional(Schema.String) }),
 *   success: Schema.Struct({ exitCode: Schema.Number, output: Schema.String }),
 *   replay: "safe",
 * }) {}
 *
 * export const RunTestsLive = RunTests.make(
 *   Effect.gen(function* () {
 *     return Effect.fn(function* ({ filter }) {
 *       const env = yield* Pi.Env;
 *       const result = yield* env.exec(["npm", "test", ...(filter ? ["--", filter] : [])]);
 *       return { exitCode: result.exitCode, output: result.stdout.slice(-8000) };
 *     });
 *   }),
 * );
 * ```
 */
export const Tool: ToolConstructor<Env, ToolSpec> = toolConstructor<Env, ToolSpec>();

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
  services: Context.Context<Env | ToolCall>,
  signal: AbortSignal | undefined,
) => Promise<Exit.Exit<A, E>>;

const textOf = (value: unknown): string =>
  value === undefined ? "done" : typeof value === "string" ? value : JSON.stringify(value);

const errorFields = (error: { readonly _tag: string }): JsonObject =>
  JSON.parse(JSON.stringify(error)) as JsonObject;

/**
 * Compile a tool and its handler into the Pi registration the harness
 * installs: arguments decoded with `parameters`, the result encoded with
 * `success` (Pi's `structuredOutput`), a declared failure turned into an
 * error result that keeps its `_tag`.
 */
export const toRegistration = (
  name: string,
  spec: ToolSpec,
  handler: ToolHandler<ToolSpec, Env>,
  run: RunTool,
): ToolRegistration => {
  const decode = Schema.decodeUnknownEffect(spec.parameters as Schema.Codec<unknown, unknown>);
  const encode = spec.success
    ? Schema.encodeUnknownEffect(spec.success as Schema.Codec<unknown, unknown>)
    : undefined;
  return {
    name,
    description: spec.description,
    parameters: jsonSchemaOf(spec.parameters),
    ...(spec.success ? { structuredOutputSchema: jsonSchemaOf(spec.success) } : {}),
    ...(spec.replay ? { replay: spec.replay } : {}),
    ...(spec.executionMode ? { executionMode: spec.executionMode } : {}),
    ...(spec.deferred ? { deferred: spec.deferred } : {}),
    ...(spec.callers ? { callers: spec.callers } : {}),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const services = Context.make(ToolCall, {
        conversationId: String(api.conversationId),
        callId: api.callId,
      }).pipe(Context.add(Env, makeEnv(requireEnv(api.env))));
      const exit = await run(
        decode(args).pipe(
          Effect.orDie,
          Effect.flatMap((parameters) => handler(parameters)),
          Effect.flatMap((value) =>
            encode ? encode(value).pipe(Effect.orDie) : Effect.succeed(value),
          ),
        ),
        services,
        context.abortSignal,
      );
      if (Exit.isSuccess(exit)) {
        const value = exit.value as JsonValue | undefined;
        return {
          output: [{ type: "text", text: textOf(value) }],
          ...(spec.success ? { structuredOutput: (value ?? null) as JsonValue } : {}),
        };
      }
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      if (failure !== undefined) {
        const error = failure.error as { readonly _tag: string; readonly message?: string };
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: `${error._tag}${error.message ? `: ${error.message}` : ""} ${JSON.stringify(errorFields(error))}`,
            },
          ],
          ...(spec.success ? { structuredOutput: errorFields(error) } : {}),
        };
      }
      // A defect or interruption: Pi turns a throw into the model's error result.
      throw new Error(messageOf(exit.cause.pipe(Cause.squash)));
    },
  } as ToolRegistration;
};

const missingEnv = new Proxy(
  {},
  {
    get: (_target, property) => {
      if (property === "then") return undefined;
      throw new Error(
        `This harness has no AI.Sandbox: the tool cannot use files or a shell (${String(property)}).`,
      );
    },
  },
);

const requireEnv = (env: ToolExecutionApi["env"]) =>
  (env ?? missingEnv) as NonNullable<ToolExecutionApi["env"]>;
