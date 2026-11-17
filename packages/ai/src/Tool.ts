import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
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
   * The tagged error the tool fails with. It reaches the model as an error
   * result that keeps its `_tag` and fields.
   */
  readonly failure?: abstract new (...args: any) => { readonly _tag: string };
  /**
   * Whether a call cut off by a crash may run again when its harness
   * resumes. Otherwise the model is told the call was interrupted. A
   * harness that never reruns a call ignores it.
   * @default "unsafe"
   */
  readonly replay?: "safe" | "unsafe";
}

type SuccessOf<Spec extends ToolSpec> = Spec["success"]["Type"];
type FailureOf<Spec extends ToolSpec> = Spec["failure"] extends abstract new (
  ...args: any
) => infer E
  ? E
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
   */
  make<R>(
    impl: Effect.Effect<PlainToolHandler<Spec>, never, R>,
  ): Layer.Layer<Self, never, Exclude<R, Scope.Scope>>;
  make<R>(
    impl: Effect.Effect<ToolHandler<Spec>, never, R>,
  ): Layer.Layer<Self, never, Exclude<R, Scope.Scope> | Sandboxes>;
}

/** A tool declared inline, closing over whatever is in scope. */
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
 * **Example:** Inline, closing over the Durable Object's bindings
 * ```typescript
 * const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);
 * const SaveNote = AI.Tool(
 *   "save_note",
 *   {
 *     description: "Save a note the user can read later.",
 *     parameters: Schema.Struct({ key: Schema.String, text: Schema.String }),
 *     success: Schema.Void,
 *   },
 *   Effect.fn(function* ({ key, text }) {
 *     yield* notes.put(key, text).pipe(Effect.orDie);
 *   }),
 * );
 * ```
 */
export const Tool = ((...args: ReadonlyArray<unknown>): unknown => {
  if (args.length === 3 && typeof args[0] === "string" && typeof args[2] === "function") {
    const [name, spec, handler] = args as [string, ToolSpec, ToolHandler<ToolSpec>];
    return { [ToolTypeId]: "inline", toolName: name, spec, handler };
  }
  return (
    name: string,
    spec: ToolSpec,
    impl?: Effect.Effect<ToolHandler<ToolSpec>, never, unknown>,
  ) => {
    const Tag = Context.Service<unknown, ToolHandler<ToolSpec>>()(`AI.Tool/${name}`);
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
}) as ToolConstructor;
