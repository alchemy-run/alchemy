import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

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
   * Whether a call cut off by a crash may run again when its harness
   * resumes. Otherwise the model is told the call was interrupted. A
   * harness that never reruns a call ignores it.
   * @default "unsafe"
   */
  readonly replay?: "safe" | "unsafe";
}

type SuccessOf<Spec extends ToolSpec> = Spec["success"] extends Schema.Top
  ? Spec["success"]["Type"]
  : void;
type FailureOf<Spec extends ToolSpec> = Spec["failure"] extends abstract new (
  ...args: any
) => infer E
  ? E
  : never;

/**
 * A tool's implementation: one call's arguments in, its result out.
 * `Services` is what its harness adds to every call (Pi adds `Pi.Env`).
 */
export type ToolHandler<Spec extends ToolSpec, Services = never> = (
  parameters: Spec["parameters"]["Type"],
) => Effect.Effect<SuccessOf<Spec>, FailureOf<Spec>, ToolCall | RuntimeContext | Services>;

/**
 * A tool declared as a class. Its implementation is either provided as a
 * Layer (`MyTool.make(...)`) or given inline as the class's third argument.
 */
export interface ToolClass<
  Self,
  Name extends string,
  Spec extends ToolSpec,
  Requires,
  Services = never,
> extends Context.ServiceClass<Self, `AI.Tool/${Name}`, ToolHandler<Spec, Services>> {
  readonly [ToolTypeId]: "class";
  readonly toolName: Name;
  readonly spec: Spec;
  /** The inline implementation, when the class has one. */
  readonly impl: Effect.Effect<ToolHandler<Spec, Services>, never, any> | undefined;
  /** Phantom: what yielding the harness that lists this tool requires. */
  readonly "~requires": Requires;
  /** Phantom: what the tool's handler needs from its harness on every call. */
  readonly "~services": Services;
  /**
   * The tool's implementation as a Layer. The Effect runs where the harness
   * is yielded (a Durable Object's outer Effect), so bindings it declares
   * are known at plan time; it returns the per-call handler.
   */
  make<R>(
    impl: Effect.Effect<ToolHandler<Spec, Services>, never, R>,
  ): Layer.Layer<Self, never, Exclude<R, Scope.Scope>>;
}

/** A tool declared inline, closing over whatever is in scope. */
export interface InlineTool<Name extends string, Spec extends ToolSpec, Services = never> {
  readonly [ToolTypeId]: "inline";
  readonly toolName: Name;
  readonly spec: Spec;
  readonly handler: ToolHandler<Spec, Services>;
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

/** The declaration forms of a tool whose handler may use `Services` and whose spec is a `BaseSpec`. */
export interface ToolConstructor<Services, BaseSpec extends ToolSpec> {
  <Self>(): {
    <const Name extends string, const Spec extends BaseSpec>(
      name: Name,
      spec: Spec,
    ): ToolClass<Self, Name, Spec, Self, Services>;
    <const Name extends string, const Spec extends BaseSpec, R>(
      name: Name,
      spec: Spec,
      impl: Effect.Effect<ToolHandler<Spec, Services>, never, R>,
    ): ToolClass<Self, Name, Spec, Exclude<R, Scope.Scope>, Services>;
  };
  <const Name extends string, const Spec extends BaseSpec>(
    name: Name,
    spec: Spec,
    handler: ToolHandler<Spec, Services>,
  ): InlineTool<Name, Spec, Services>;
}

/**
 * The tool declaration of one harness: the same forms as {@link Tool}, with
 * the services that harness adds to every call and the options it adds to a
 * spec. A tool declared with it runs only on that harness.
 */
export const toolConstructor = <Services = never, BaseSpec extends ToolSpec = ToolSpec>() =>
  ((...args: ReadonlyArray<unknown>): unknown => {
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
  }) as ToolConstructor<Services, BaseSpec>;

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
 * **Example:** Inline, closing over the Durable Object's bindings
 * ```typescript
 * const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);
 * const SaveNote = AI.Tool(
 *   "save_note",
 *   {
 *     description: "Save a note the user can read later.",
 *     parameters: Schema.Struct({ key: Schema.String, text: Schema.String }),
 *   },
 *   Effect.fn(function* ({ key, text }) {
 *     yield* notes.put(key, text).pipe(Effect.orDie);
 *   }),
 * );
 * ```
 */
export const Tool: ToolConstructor<never, ToolSpec> = toolConstructor();
