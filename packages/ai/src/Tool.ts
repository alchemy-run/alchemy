import { calling, framed } from "alchemy/CapabilityGraph";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Tool as AiTool } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { Sandbox, Sandboxes } from "./Sandbox.ts";

const ToolTypeId = "~alchemy/AI/Tool" as const;

/** The call a tool handler is answering. */
export class ToolCall extends Context.Service<
  ToolCall,
  {
    /** The conversation the call belongs to, as its harness identifies it. */
    readonly conversationId: string;
    readonly callId: string;
  }
>()("AI.ToolCall") {}

/** What a tool says it takes and returns. */
export interface ToolSpec {
  /** Shown to the model. Say what the tool does and when to use it. */
  readonly description: string;
  /** The arguments, decoded before the handler runs. */
  readonly parameters: Schema.Top;
  /**
   * What the tool returns. Programs that call the tool (code mode, other
   * tools) see it as a typed value; the model sees it as JSON. A tool that
   * acts and returns nothing says so with `Schema.Void`.
   */
  readonly success: Schema.Top;
  /**
   * What the tool fails with: a `Schema.TaggedError` class, or a
   * `Schema.Union` of several. A failure reaches the model as an error
   * result that keeps its `_tag` and fields, encoded by this schema.
   */
  readonly failure?: Schema.Top;
  /**
   * Whether a call cut off by a crash may run again when its harness
   * resumes. Otherwise the model is told the call was interrupted. A
   * harness that never reruns a call ignores it.
   * @default "unsafe"
   */
  readonly replay?: "safe" | "unsafe";
}

type SuccessOf<Spec extends ToolSpec> = Spec["success"]["Type"];
type FailureOf<Spec extends ToolSpec> = Spec["failure"] extends Schema.Top
  ? Spec["failure"]["Type"]
  : never;

/**
 * A tool's implementation: one call's arguments in, its result out. A
 * handler runs in its harness and may use the call (`AI.ToolCall`) and the
 * sandbox of the call's conversation (`AI.Sandbox`).
 */
export type ToolHandler<Spec extends ToolSpec> = (
  parameters: Spec["parameters"]["Type"],
) => Effect.Effect<SuccessOf<Spec>, FailureOf<Spec>, ToolServices>;

/** A handler that uses the conversation's sandbox needs a harness that has sandboxes. */
export type SandboxesFor<Uses> = [Uses] extends [never] ? never : Sandboxes;

/** What a handler may require. */
export type ToolServices = ToolCall | RuntimeContext | Sandbox;

/** A handler that leaves the conversation's sandbox alone. */
export type PlainToolHandler<Spec extends ToolSpec> = (
  parameters: Spec["parameters"]["Type"],
) => Effect.Effect<SuccessOf<Spec>, FailureOf<Spec>, ToolCall | RuntimeContext>;

/**
 * What `make` takes: the handler, or an Effect that builds it. A handler
 * returns an Effect or, when it needs none, the result itself. `Uses` is
 * what the handler's Effect requires, `R` what building it does.
 */
export type ToolImpl<Spec extends ToolSpec, Uses extends ToolServices, R> =
  | ((
      parameters: Spec["parameters"]["Type"],
    ) => SuccessOf<Spec> | Effect.Effect<SuccessOf<Spec>, FailureOf<Spec>, Uses>)
  | Effect.Effect<
      (
        parameters: Spec["parameters"]["Type"],
      ) => SuccessOf<Spec> | Effect.Effect<SuccessOf<Spec>, FailureOf<Spec>, Uses>,
      never,
      R
    >;

/** What an implementation's Layer requires: what building it needs, and sandboxes when its handler uses one. */
export type ImplRequirements<Uses, R> =
  | Exclude<R, Scope.Scope>
  | SandboxesFor<Extract<Uses, Sandbox>>;

/**
 * A tool declared as a class. Its implementation is either provided as a
 * Layer (`MyTool.make(...)`) or given inline as the class's third argument.
 */
export interface ToolClass<
  Self,
  Name extends string,
  Spec extends ToolSpec,
  Requires,
> extends Context.ServiceClass<Self, `AI.Tool/${Name}`, ToolHandler<Spec>> {
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
   * are known at plan time; it returns the per-call handler. A handler that
   * uses `AI.Sandbox` makes the Layer require `AI.Sandboxes`.
   *
   * A tool with nothing to build first passes the handler alone: an
   * `Effect.fn`, or a function that returns the result.
   */
  make<Uses extends ToolServices = never, R = never>(
    impl: ToolImpl<Spec, Uses, R>,
  ): Layer.Layer<Self, never, ImplRequirements<Uses, R>>;
  make<R>(
    impl: Effect.Effect<PlainToolHandler<Spec>, never, R>,
  ): Layer.Layer<Self, never, Exclude<R, Scope.Scope>>;
  make<R>(
    impl: Effect.Effect<ToolHandler<Spec>, never, R>,
  ): Layer.Layer<Self, never, Exclude<R, Scope.Scope> | Sandboxes>;
}

/** A tool declared inline: a value, with no Layer to provide. */
export interface InlineTool<
  Name extends string,
  Spec extends ToolSpec,
  Uses extends Sandbox = never,
> {
  readonly [ToolTypeId]: "inline";
  readonly toolName: Name;
  readonly spec: Spec;
  readonly handler: ToolHandler<Spec>;
  /** Phantom: whether the handler uses the conversation's sandbox. */
  readonly "~uses"?: Uses;
}

/** Any tool class, structurally: what a harness reads off it. */
export interface AnyToolClass {
  readonly [ToolTypeId]: "class";
  readonly key: string;
  readonly toolName: string;
  readonly spec: ToolSpec;
  readonly impl: Effect.Effect<any, never, any> | undefined;
}

/** Any declared tool. */
export type AnyTool = AnyToolClass | InlineTool<string, any, any>;

export const isTool = (u: unknown): u is AnyTool =>
  (typeof u === "object" || typeof u === "function") && u !== null && ToolTypeId in u;

/** How a tool was declared: as a class, or inline. */
export const toolKind = (tool: AnyTool): "class" | "inline" => tool[ToolTypeId];

/** The declaration forms of a tool. */
export interface ToolConstructor {
  <Self>(): {
    /** A tool known only by name: its Layer brings the description, the schema and the implementation. */
    <const Name extends string>(name: Name): ToolTagClass<Self, Name>;
    <const Name extends string, const Spec extends ToolSpec>(
      name: Name,
      spec: Spec,
    ): ToolClass<Self, Name, Spec, Self>;
    <const Name extends string, const Spec extends ToolSpec, R>(
      name: Name,
      spec: Spec,
      impl: Effect.Effect<PlainToolHandler<Spec>, never, R>,
    ): ToolClass<Self, Name, Spec, Exclude<R, Scope.Scope>>;
    <const Name extends string, const Spec extends ToolSpec, R>(
      name: Name,
      spec: Spec,
      impl: Effect.Effect<ToolHandler<Spec>, never, R>,
    ): ToolClass<Self, Name, Spec, Exclude<R, Scope.Scope> | Sandboxes>;
  };
  <const Name extends string, const Spec extends ToolSpec>(
    name: Name,
    spec: Spec,
    handler: PlainToolHandler<Spec>,
  ): InlineTool<Name, Spec>;
  <const Name extends string, const Spec extends ToolSpec>(
    name: Name,
    spec: Spec,
    handler: ToolHandler<Spec>,
  ): InlineTool<Name, Spec, Sandbox>;
}

/**
 * Declare a tool. The same declaration runs on any harness.
 *
 * **Example:** A contract, implemented by a Layer
 * ```typescript
 * export class Deploy extends AI.Tool<Deploy>()("deploy", {
 *   description: "Upload a release archive.",
 *   parameters: Schema.Struct({ version: Schema.String, archive: Schema.String }),
 *   success: Schema.Struct({ url: Schema.String }),
 * }) {}
 *
 * export const DeployLive = Deploy.make(
 *   Effect.gen(function* () {
 *     const releases = yield* Cloudflare.R2.WriteBucket(Releases);
 *     return Effect.fn(function* ({ version, archive }) {
 *       yield* releases.put(`releases/${version}.tgz`, archive).pipe(Effect.orDie);
 *       return { url: `https://releases.example.com/${version}.tgz` };
 *     });
 *   }),
 * );
 * ```
 *
 * **Example:** A tool that fails with one of several errors
 * ```typescript
 * export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
 *   version: Schema.String,
 * }) {}
 * export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
 *   reason: Schema.String,
 * }) {}
 *
 * export class Deploy extends AI.Tool<Deploy>()("deploy", {
 *   description: "Upload a release archive.",
 *   parameters: Schema.Struct({ version: Schema.String }),
 *   success: Schema.Struct({ url: Schema.String }),
 *   failure: Schema.Union([NotFound, Forbidden]),
 * }) {}
 *
 * export const DeployLive = Deploy.make(
 *   Effect.fn(function* ({ version }) {
 *     if (version === "0.0.0") return yield* new NotFound({ version });
 *     return { url: `https://releases.example.com/${version}.tgz` };
 *   }),
 * );
 * ```
 *
 * **Example:** The handler alone
 * ```typescript
 * export const AddLive = Add.make(({ a, b }) => ({ sum: a + b }));
 *
 * export const FetchLive = Fetch.make(
 *   Effect.fn(function* ({ url }) {
 *     const sandbox = yield* AI.Sandbox;
 *     return yield* sandbox.exec(["curl", "-s", url]).pipe(Effect.orDie);
 *   }),
 * );
 * ```
 *
 * **Example:** A tool that works in the conversation's sandbox
 * ```typescript
 * export class RunTests extends AI.Tool<RunTests>()("run_tests", {
 *   description: "Run the test suite.",
 *   parameters: Schema.Struct({}),
 *   success: Schema.Struct({ exitCode: Schema.Number }),
 * }) {}
 *
 * // Requires `AI.Sandboxes`, because the handler uses `AI.Sandbox`.
 * export const RunTestsLive = RunTests.make(
 *   Effect.gen(function* () {
 *     return Effect.fn(function* () {
 *       const sandbox = yield* AI.Sandbox;
 *       const result = yield* sandbox.exec(["npm", "test"]).pipe(Effect.orDie);
 *       return { exitCode: result.exitCode };
 *     });
 *   }),
 * );
 * ```
 *
 * **Example:** A name only, implemented differently on each harness
 * ```typescript
 * export class Bash extends AI.Tool<Bash>()("bash") {}
 *
 * // A coding agent's own tool, or yours with its own schema:
 * const OnOpenCode = OpenCode.Bash;
 * const Mine = Bash.make(
 *   {
 *     description: "Run a shell command.",
 *     parameters: Schema.Struct({ command: Schema.String }),
 *     success: Schema.Struct({ exitCode: Schema.Number }),
 *   },
 *   Effect.fn(function* ({ command }) {
 *     const sandbox = yield* AI.Sandbox;
 *     const result = yield* sandbox.exec(["sh", "-c", command]).pipe(Effect.orDie);
 *     return { exitCode: result.exitCode };
 *   }),
 * );
 * ```
 *
 * **Example:** A class with its implementation, and no Layer to provide
 * ```typescript
 * // The Effect binds what the tool uses and returns its handler. A plan
 * // lists the namespace under `save_note`, and at runtime the tool can use
 * // no binding the plan does not list under it.
 * export class SaveNote extends AI.Tool<SaveNote>()(
 *   "save_note",
 *   {
 *     description: "Save a note the user can read later.",
 *     parameters: Schema.Struct({ key: Schema.String, text: Schema.String }),
 *     success: Schema.Void,
 *   },
 *   Effect.gen(function* () {
 *     const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);
 *     return Effect.fn(function* ({ key, text }) {
 *       yield* notes.put(key, text).pipe(Effect.orDie);
 *     });
 *   }),
 * ) {}
 * ```
 *
 * **Example:** A value, for a tool that uses nothing
 * ```typescript
 * const Add = AI.Tool(
 *   "add",
 *   {
 *     description: "Add two numbers.",
 *     parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
 *     success: Schema.Struct({ sum: Schema.Number }),
 *   },
 *   ({ a, b }) => Effect.succeed({ sum: a + b }),
 * );
 * ```
 */
type AnyHandler = (parameters: unknown) => unknown;

/** A handler that may return its result directly, as one that always returns an Effect. */
const lift =
  (handler: AnyHandler): ToolHandler<ToolSpec> =>
  (parameters) =>
    Effect.suspend(() => {
      const result = handler(parameters);
      return Effect.isEffect(result)
        ? (result as unknown as ReturnType<ToolHandler<ToolSpec>>)
        : Effect.succeed(result);
    });

/**
 * A handler that runs as the tool `name`: a binding it uses must be one the
 * plan lists under that tool (alchemy's CapabilityGraph).
 */
const called =
  (name: string, handler: ToolHandler<ToolSpec>): ToolHandler<ToolSpec> =>
  (parameters) =>
    calling("Tool", name)(handler(parameters));

/** What `make` was given, as the Effect that builds the handler. */
const implOf = (
  name: string,
  impl: Effect.Effect<AnyHandler, never, unknown> | AnyHandler,
): Effect.Effect<ToolHandler<ToolSpec>, never, unknown> =>
  Effect.isEffect(impl)
    ? Effect.map(impl, (handler) => called(name, lift(handler)))
    : Effect.succeed(called(name, lift(impl)));

/**
 * An inline tool of the framework's own (a process's `start_` and `follow_`
 * tools). It does not run as a named tool, so what it uses is not held to
 * the plan's list: it has no Layer where a binding could be listed.
 *
 * @internal
 */
export const ownTool = ((name: string, spec: ToolSpec, handler: AnyHandler): unknown => ({
  [ToolTypeId]: "inline",
  toolName: name,
  spec,
  handler: lift(handler),
})) as ToolConstructor;

export const Tool = ((...args: ReadonlyArray<unknown>): unknown => {
  if (args.length === 3 && typeof args[0] === "string" && typeof args[2] === "function") {
    const [name, spec, handler] = args as [string, ToolSpec, AnyHandler];
    return { [ToolTypeId]: "inline", toolName: name, spec, handler: called(name, lift(handler)) };
  }
  return (name: string, spec?: ToolSpec, impl?: Effect.Effect<AnyHandler, never, unknown>) => {
    if (spec === undefined) return toolTag(name);
    const Tag = Context.Service<unknown, ToolHandler<ToolSpec>>()(`AI.Tool/${name}`);
    return class extends Tag {
      static readonly [ToolTypeId] = "class";
      static readonly toolName = name;
      static readonly spec = spec;
      // Built under the tool's own frame, like its Layer would be.
      static readonly impl =
        impl === undefined ? undefined : framed("Tool", name)(implOf(name, impl));
      static make(implementation: Effect.Effect<AnyHandler, never, unknown> | AnyHandler) {
        // Built under the tool's own frame: what it binds is what the tool can reach.
        return Layer.effect(this as never, framed("Tool", name)(implOf(name, implementation)));
      }
    };
  };
}) as ToolConstructor;

/** What one tool call gave: what the model reads, and the value behind it. */
export interface ToolResult {
  /** What the model reads: the value as JSON, or the failure's `_tag`, message and fields. */
  readonly text: string;
  /** The encoded `success` value, or a declared failure's fields. Absent for `Schema.Void`. */
  readonly structured?: unknown;
  /** The handler failed with the tool's declared `failure`. */
  readonly isError: boolean;
}

/** A tool's `parameters` as the JSON Schema a model is given. */
export const parametersJsonSchema = (spec: ToolSpec): object =>
  AiTool.getJsonSchemaFromSchema(spec.parameters) as object;

/** `value` without the object fields that are `null`, at any depth. */
const withoutNulls = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutNulls)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, field]) => field !== null)
            .map(([key, field]) => [key, withoutNulls(field)]),
        )
      : value;

/**
 * Run one call of a tool the way every harness does: arguments decoded with
 * `parameters`, the result encoded with `success`, a declared failure turned
 * into an error result that keeps its `_tag` and fields. Arguments that do
 * not decode, and defects, die: the harness tells the model in its own way.
 *
 * @internal
 */
export const callTool = (
  spec: ToolSpec,
  handler: ToolHandler<ToolSpec>,
  args: unknown,
): Effect.Effect<ToolResult, never, ToolServices> => {
  const returns = spec.success.ast._tag !== "Void";
  const decode = Schema.decodeUnknownEffect(spec.parameters as Schema.Codec<unknown, unknown>);
  return decode(args).pipe(
    // Models often send `null` for a parameter they leave out. Where the
    // arguments do not decode as sent, they are read again without their nulls.
    // The failure reported is the one for the arguments as they were sent.
    Effect.catch((error) => Effect.mapError(decode(withoutNulls(args)), () => error)),
    Effect.orDie,
    Effect.flatMap((parameters) => handler(parameters)),
    Effect.flatMap((value) =>
      returns
        ? Schema.encodeUnknownEffect(spec.success as Schema.Codec<unknown, unknown>)(value).pipe(
            Effect.orDie,
          )
        : Effect.succeed(undefined),
    ),
    Effect.exit,
    Effect.flatMap((exit): Effect.Effect<ToolResult> => {
      if (Exit.isSuccess(exit)) {
        const value = exit.value;
        return Effect.succeed({
          text:
            value === undefined
              ? "done"
              : typeof value === "string"
                ? value
                : JSON.stringify(value),
          ...(returns ? { structured: value ?? null } : {}),
          isError: false,
        });
      }
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      if (failure === undefined) return Effect.failCause(exit.cause as Cause.Cause<never>);
      // The handler's type allows only the declared failure, so the schema encodes it.
      return Schema.encodeUnknownEffect(spec.failure as Schema.Codec<unknown, unknown>)(
        failure.error,
      ).pipe(
        Effect.orDie,
        Effect.map((fields): ToolResult => ({
          text: typeof fields === "string" ? fields : JSON.stringify(fields),
          ...(returns ? { structured: fields } : {}),
          isError: true,
        })),
      );
    }),
  );
};

const ToolTagTypeId = "~alchemy/AI/ToolTag" as const;

/**
 * What a Layer for a tool tag provides: a whole tool, or a reference to
 * the tool a coding agent ships under that name.
 */
export type ToolTagService =
  | {
      readonly kind: "tool";
      readonly spec: ToolSpec;
      readonly handler: ToolHandler<ToolSpec>;
    }
  | {
      readonly kind: "native";
      /** The coding agent whose tool this is (`pi`, `opencode`). */
      readonly engine: string;
      /** How that agent's harness finds the tool. */
      readonly tool: unknown;
    };

/**
 * A tool known only by name (`AI.Bash`, `AI.Read`). Its description, its
 * schema and its implementation come from the Layer provided for it, so
 * the same name can be a coding agent's own tool on one harness and yours
 * on another.
 */
export interface ToolTagClass<Self, Name extends string> extends Context.ServiceClass<
  Self,
  `AI.Tool/${Name}`,
  ToolTagService
> {
  readonly [ToolTagTypeId]: true;
  readonly toolName: Name;
  /**
   * Implement the tool yourself. The Effect runs where the harness is
   * yielded and returns the per-call handler; a handler that uses
   * `AI.Sandbox` makes the Layer require `AI.Sandboxes`.
   */
  make<const Spec extends ToolSpec, R = never>(
    spec: Spec,
    impl: ToolImpl<Spec, ToolCall | RuntimeContext, R>,
  ): Layer.Layer<Self, never, Exclude<R, Scope.Scope>>;
  make<const Spec extends ToolSpec, R = never>(
    spec: Spec,
    impl: ToolImpl<Spec, ToolServices, R>,
  ): Layer.Layer<Self, never, Exclude<R, Scope.Scope> | Sandboxes>;
  /**
   * Use a coding agent's own tool of this name. A harness package builds
   * its Layers with it (`OpenCode.Bash`, `Pi.Bash`).
   */
  native(engine: string, tool: unknown): Layer.Layer<Self>;
}

/** Any tool tag, structurally: what a harness reads off it. */
export interface AnyToolTag {
  readonly [ToolTagTypeId]: true;
  readonly key: string;
  readonly toolName: string;
}

export const isToolTag = (u: unknown): u is AnyToolTag =>
  (typeof u === "object" || typeof u === "function") && u !== null && ToolTagTypeId in u;

/** A tool declared by name only (`AI.Tool<Self>()(name)`). */
const toolTag = (name: string) => {
  const Tag = Context.Service<unknown, ToolTagService>()(`AI.Tool/${name}`);
  return class extends Tag {
    static readonly [ToolTagTypeId] = true;
    static readonly toolName = name;
    static make(spec: ToolSpec, impl: Effect.Effect<AnyHandler, never, unknown> | AnyHandler) {
      return Layer.effect(
        this as never,
        framed(
          "Tool",
          name,
        )(
          Effect.map(implOf(name, impl), (handler): ToolTagService => ({
            kind: "tool",
            spec,
            handler,
          })),
        ),
      );
    }
    static native(engine: string, tool: unknown) {
      return Layer.succeed(this as never, { kind: "native", engine, tool } as never);
    }
  };
};

const ToolGroupTypeId = "~alchemy/AI/ToolGroup" as const;

/** Several tools listed as one. */
export interface ToolGroup<Tools extends ReadonlyArray<unknown> = ReadonlyArray<unknown>> {
  readonly [ToolGroupTypeId]: true;
  readonly tools: Tools;
}

export const isToolGroup = (u: unknown): u is ToolGroup =>
  typeof u === "object" && u !== null && ToolGroupTypeId in u;

/** Group tools so one name lists them all. */
export const ToolGroup = <const Tools extends ReadonlyArray<unknown>>(
  ...tools: Tools
): ToolGroup<Tools> => ({ [ToolGroupTypeId]: true, tools });
