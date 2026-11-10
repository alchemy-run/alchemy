import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { JsonObject, ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { AnyTool, ToolRequirements, ToolServices } from "./Tool.ts";

const ExtensionTypeId = "~alchemy/Pi/Extension" as const;

/** What an extension declares: its static prompt sections and the tools it brings. */
export interface ExtensionSpec {
  /** System prompt sections that never change, by key. */
  readonly sections?: Readonly<Record<string, string>>;
  /** Tools that come with the extension: enabled where it is selected. */
  readonly tools?: ReadonlyArray<AnyTool>;
}

/** Services an extension's sections and hooks may use. */
export type ExtensionServices = Exclude<ToolServices, import("./Env.ts").Env>;

/** The input a dynamic section renders from. */
export interface SectionInput {
  readonly conversationId: ConversationId;
}

/**
 * What an extension does: sections rendered before each model request,
 * and hooks on the harness's tool calls and generations. Every function
 * is an Effect; return `undefined` to change nothing.
 */
export interface ExtensionImpl {
  readonly sections?: Readonly<
    Record<
      string,
      (input: SectionInput) => Effect.Effect<string | undefined, never, ExtensionServices>
    >
  >;
  readonly hooks?: {
    /** Block a call (`Pi.block(reason)`) or rewrite its arguments. */
    readonly beforeTool?: (
      call: ToolHookCall,
    ) => Effect.Effect<
      { readonly arguments?: JsonObject; readonly block?: string } | undefined,
      never,
      ExtensionServices
    >;
    /** Replace a call's result. */
    readonly afterTool?: (
      call: ToolHookCall,
      result: ToolExecutionResult,
    ) => Effect.Effect<ToolExecutionResult | undefined, never, ExtensionServices>;
    /** Replace the messages of one model request. */
    readonly beforeRequest?: (request: {
      readonly messages: ReadonlyArray<Message>;
    }) => Effect.Effect<
      { readonly messages: ReadonlyArray<Message> } | undefined,
      never,
      ExtensionServices
    >;
    /** Observe each answer. */
    readonly afterResponse?: (
      message: AssistantMessage,
    ) => Effect.Effect<void, never, ExtensionServices>;
    /** Keep a run going with another user message instead of ending it. */
    readonly onYield?: (
      answer: AssistantMessage,
    ) => Effect.Effect<{ readonly continue: string } | undefined, never, ExtensionServices>;
  };
}

/** Block a tool call with this reason, shown to the model. */
export const block = (reason: string) => ({ block: reason }) as const;

export interface ExtensionClass<
  Self,
  Name extends string,
  Spec extends ExtensionSpec,
  Requires,
> extends Context.ServiceClass<Self, `Pi.Extension/${Name}`, ExtensionImpl> {
  readonly [ExtensionTypeId]: "class";
  readonly extensionName: Name;
  readonly spec: Spec;
  readonly impl: Effect.Effect<ExtensionImpl, never, any> | undefined;
  /** Whether the extension has behavior (sections or hooks) to provide. */
  readonly hasImpl: boolean;
  readonly "~requires": Requires;
  /** The extension's sections and hooks as a Layer. */
  make<R>(
    impl: Effect.Effect<ExtensionImpl, never, R>,
  ): Layer.Layer<Self, never, Exclude<R, Scope.Scope>>;
}

/** Any extension, structurally: what a harness reads off it. */
export interface AnyExtension {
  readonly [ExtensionTypeId]: "class" | "skill" | "codemode";
  readonly key: string;
  readonly extensionName: string;
  readonly spec: ExtensionSpec;
  readonly impl: Effect.Effect<ExtensionImpl, never, any> | undefined;
  readonly hasImpl: boolean;
}

export type ExtensionRequirements<T> =
  T extends ExtensionClass<any, any, infer Spec, infer Requires>
    ? Requires | ToolRequirements<NonNullable<Spec["tools"]>[number]>
    : T extends { readonly "~requires": infer Requires }
      ? Requires
      : never;

/**
 * Declare an extension: a named bundle of prompt sections, tools and
 * hooks that conversations select by name.
 *
 * **Example:** Static sections and tools, no behavior
 * ```typescript
 * export class Coder extends Pi.Extension<Coder>()("coder", {
 *   sections: { role: "You are a careful engineer. Run the tests before you finish." },
 *   tools: [RunTests],
 * }) {}
 * ```
 *
 * **Example:** A guard whose hook blocks deploys
 * ```typescript
 * export class Guard extends Pi.Extension<Guard>()(
 *   "guard",
 *   {},
 *   Effect.gen(function* () {
 *     return {
 *       hooks: {
 *         beforeTool: Effect.fn(function* (call) {
 *           return call.name === "deploy" ? Pi.block("Deploys need approval.") : undefined;
 *         }),
 *       },
 *     };
 *   }),
 * ) {}
 * ```
 */
export const Extension =
  <Self>() =>
  <const Name extends string, const Spec extends ExtensionSpec, R = never>(
    name: Name,
    spec: Spec,
    impl?: Effect.Effect<ExtensionImpl, never, R>,
  ): ExtensionClass<Self, Name, Spec, Exclude<R, Scope.Scope>> => {
    const Tag = Context.Service<Self, ExtensionImpl>()(`Pi.Extension/${name}`);
    return class extends Tag {
      static readonly [ExtensionTypeId] = "class";
      static readonly extensionName = name;
      static readonly spec = spec;
      static readonly impl = impl;
      static readonly hasImpl = impl !== undefined;
      static make(implementation: Effect.Effect<ExtensionImpl, never, unknown>) {
        return Layer.effect(this as never, implementation);
      }
    } as unknown as ExtensionClass<Self, Name, Spec, Exclude<R, Scope.Scope>>;
  };

export const isExtension = (u: unknown): u is AnyExtension =>
  (typeof u === "object" || typeof u === "function") && u !== null && ExtensionTypeId in u;
