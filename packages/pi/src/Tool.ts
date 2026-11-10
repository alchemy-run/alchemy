import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
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
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { Env, makeEnv } from "./Env.ts";
import { messageOf } from "./internal/promise.ts";

/** The call a tool handler is answering. */
export class ToolCall extends Context.Service<
  ToolCall,
  {
    readonly conversationId: ConversationId;
    readonly callId: string;
    /** Pi's own API for this call (`output`, `details`, `executeTool`, …). */
    readonly api: ToolExecutionApi;
  }
>()("Pi.ToolCall") {}

/** What a tool says it takes and returns. */
export interface ToolSpec {
  /** Shown to the model. Say what the tool does and when to use it. */
  readonly description: string;
  /** The arguments, decoded before the handler runs. */
  readonly parameters: Schema.Top;
  /**
   * What the tool returns. Programs that call the tool (code mode, other
   * tools) see it as a typed value; the model sees it as JSON. Leave it out
   * for a tool that acts and returns nothing.
   */
  readonly success?: Schema.Top;
  /**
   * The tagged error the tool fails with. It reaches the model as an error
   * result that keeps its `_tag` and fields.
   */
  readonly failure?: abstract new (...args: any) => { readonly _tag: string };
  /**
   * Whether a call cut off by a crash may run again when the harness
   * resumes. Otherwise the model is told the call was interrupted.
   * @default "unsafe"
   */
  readonly replay?: "safe" | "unsafe";
  /** Run this tool's calls one at a time, or alongside the round's others. */
  readonly executionMode?: "parallel" | "sequential";
  /** Hidden from the model until a tool search loads it. */
  readonly deferred?: true;
  /** Who may call it: the model, other tools (code mode), or both. */
  readonly callers?: ReadonlyArray<"model" | "tools">;
}

/** The services every tool handler may use. */
export type ToolServices = Env | ToolCall | RuntimeContext;

type SuccessOf<Spec extends ToolSpec> = Spec["success"] extends Schema.Top
  ? Spec["success"]["Type"]
  : void;
type FailureOf<Spec extends ToolSpec> = Spec["failure"] extends abstract new (
  ...args: any
) => infer E
  ? E
  : never;

/** A tool's implementation: one call's arguments in, its result out. */
export type ToolHandler<Spec extends ToolSpec> = (
  parameters: Spec["parameters"]["Type"],
) => Effect.Effect<SuccessOf<Spec>, FailureOf<Spec>, ToolServices>;

const ToolTypeId = "~alchemy/Pi/Tool" as const;

/**
 * A tool declared as a class. Its implementation is either provided as a
 * Layer (`MyTool.make(...)`) or given inline as the class's third argument.
 */
export interface ToolClass<
  Self,
  Name extends string,
  Spec extends ToolSpec,
  Requires,
> extends Context.ServiceClass<Self, `Pi.Tool/${Name}`, ToolHandler<Spec>> {
  readonly [ToolTypeId]: "class";
  readonly toolName: Name;
  readonly spec: Spec;
  /** The inline implementation, when the class has one. */
  readonly impl: Effect.Effect<ToolHandler<Spec>, never, any> | undefined;
  /** Phantom: what yielding the harness that lists this tool requires. */
  readonly "~requires": Requires;
  /**
   * The tool's implementation as a Layer. The Effect runs where the harness
   * is yielded (a Durable Object's outer Effect), so bindings it declares
   * are known at plan time; it returns the per-call handler.
   */
  make<R>(
    impl: Effect.Effect<ToolHandler<Spec>, never, R>,
  ): Layer.Layer<Self, never, Exclude<R, Scope.Scope>>;
}

/** A tool declared inline, closing over whatever is in scope. */
export interface InlineTool<Name extends string, Spec extends ToolSpec> {
  readonly [ToolTypeId]: "inline";
  readonly toolName: Name;
  readonly spec: Spec;
  readonly handler: ToolHandler<Spec>;
}

/** One of Pi's own tools (`read`, `bash`, …), used as is. */
export interface BuiltinTool<Name extends string = string> {
  readonly [ToolTypeId]: "builtin";
  readonly toolName: Name;
  readonly registration: ToolRegistration;
}

/** Several tools listed as one. */
export interface ToolGroup<Tools extends ReadonlyArray<AnyTool> = ReadonlyArray<AnyTool>> {
  readonly [ToolTypeId]: "group";
  readonly tools: Tools;
}

/** Any tool class, structurally: what a harness reads off it. */
export interface AnyToolClass {
  readonly [ToolTypeId]: "class";
  readonly key: string;
  readonly toolName: string;
  readonly spec: ToolSpec;
  readonly impl: Effect.Effect<any, never, any> | undefined;
}
export type AnyTool = AnyToolClass | InlineTool<string, any> | BuiltinTool | ToolGroup;

/** What listing `T` on a harness requires to be provided. */
export type ToolRequirements<T> =
  T extends ToolClass<any, any, any, infer Requires>
    ? Requires
    : T extends ToolGroup<infer Tools>
      ? Tools[number] extends ToolClass<any, any, any, infer Requires>
        ? Requires
        : never
      : never;

/** A tool that can be enabled on a conversation, by reference. */
export type ToolRef = AnyToolClass | InlineTool<string, any> | BuiltinTool;

export const isTool = (u: unknown): u is AnyTool =>
  (typeof u === "object" || typeof u === "function") && u !== null && ToolTypeId in u;

/** The tool's name as the model sees it. */
export const toolNameOf = (tool: ToolRef): string => tool.toolName;

/** Every tool a list names, groups flattened. */
export const flattenTools = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolRef> =>
  tools.flatMap((tool) =>
    tool[ToolTypeId] === "group" ? flattenTools((tool as ToolGroup).tools) : [tool as ToolRef],
  );

/**
 * Declare a tool.
 *
 * **Example:** A contract, implemented by a Layer
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
 *
 * **Example:** Inline, closing over the Durable Object's bindings
 * ```typescript
 * const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);
 * const SaveNote = Pi.Tool(
 *   "save_note",
 *   {
 *     description: "Save a note the user can read later.",
 *     parameters: Schema.Struct({ key: Schema.String, text: Schema.String }),
 *   },
 *   Effect.fn(function* ({ key, text }) {
 *     yield* notes.put(key, text);
 *   }),
 * );
 * ```
 */
export function Tool<Self>(): {
  <const Name extends string, const Spec extends ToolSpec>(
    name: Name,
    spec: Spec,
  ): ToolClass<Self, Name, Spec, Self>;
  <const Name extends string, const Spec extends ToolSpec, R>(
    name: Name,
    spec: Spec,
    impl: Effect.Effect<ToolHandler<Spec>, never, R>,
  ): ToolClass<Self, Name, Spec, Exclude<R, Scope.Scope>>;
};
export function Tool<const Name extends string, const Spec extends ToolSpec>(
  name: Name,
  spec: Spec,
  handler: ToolHandler<Spec>,
): InlineTool<Name, Spec>;
export function Tool(...args: ReadonlyArray<unknown>): unknown {
  if (args.length === 3 && typeof args[0] === "string" && typeof args[2] === "function") {
    const [name, spec, handler] = args as [string, ToolSpec, ToolHandler<ToolSpec>];
    return { [ToolTypeId]: "inline", toolName: name, spec, handler } satisfies InlineTool<
      string,
      ToolSpec
    >;
  }
  return (
    name: string,
    spec: ToolSpec,
    impl?: Effect.Effect<ToolHandler<ToolSpec>, never, unknown>,
  ) => {
    const Tag = Context.Service<unknown, ToolHandler<ToolSpec>>()(`Pi.Tool/${name}`);
    return class extends Tag {
      static readonly [ToolTypeId] = "class";
      static readonly toolName = name;
      static readonly spec = spec;
      static readonly impl = impl;
      static make(implementation: Effect.Effect<ToolHandler<ToolSpec>, never, unknown>) {
        return Layer.effect(this as never, implementation);
      }
    };
  };
}

/** Group tools so one name lists them all. */
export const group = <const Tools extends ReadonlyArray<AnyTool>>(
  ...tools: Tools
): ToolGroup<Tools> => ({
  [ToolTypeId]: "group",
  tools,
});

/** Wrap one of Pi's own tool registrations. */
export const builtin = <Name extends string>(
  registration: ToolRegistration & { name: Name },
): BuiltinTool<Name> => ({
  [ToolTypeId]: "builtin",
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
  handler: ToolHandler<ToolSpec>,
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
        conversationId: api.conversationId,
        callId: api.callId,
        api: api as ToolExecutionApi,
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
        `This harness has no environment (Pi.NoEnv): the tool cannot use files or a shell (${String(property)}).`,
      );
    },
  },
);

const requireEnv = (env: ToolExecutionApi["env"]) =>
  (env ?? missingEnv) as NonNullable<ToolExecutionApi["env"]>;
