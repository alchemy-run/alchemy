import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { DispatchTool } from "./Dispatch.ts";
import type { Fragment } from "./Prose.ts";
import type { Tool, ToolImpl, ToolParameters } from "./Tool.ts";

/**
 * The WIRE surface of an agent: the set of tool calls that can appear
 * on its transcript, as a type. Mention-is-presence is a runtime law —
 * a charter's toolkit is exactly what its prose splices — and because
 * {@link Fragment} retains its refs' types, the same law holds in the
 * type system: `CharterTools<C>` extracts every tool a charter can
 * mention, and a UI can prove renderer coverage against it the same
 * way `Layer.provide` proves service coverage.
 *
 * The core exposes only the FACTS — {@link ToolNames}, {@link ToolInput},
 * the {@link WiredLayer} brand. What a consumer builds on them (a
 * renderer registry, a wire-protocol codec, a docs generator) is
 * userland; e.g. a UI derives its own registry contract:
 *
 * ```ts
 * // server — the layer's type carries its wire surface:
 * export const ReviewBotLive = ReviewBot.make(Effect.gen(...));
 *
 * // ui — type-only import (erased at build; no server code in the
 * // browser bundle); the app owns its registry type:
 * import type { ReviewBotLive } from "../src/ReviewBot.ts";
 *
 * type Renderers<L> = {
 *   [Name in AI.ToolNames<L> & string]: (
 *     input: AI.ToolInput<L, Name>,
 *   ) => ToolCallView;
 * };
 *
 * const RENDERERS: Renderers<typeof ReviewBotLive> = {
 *   comment: (input) => ({ ... }),   // input: { message: string }
 *   sync_checkout: () => ({ ... }),
 *   readDiff: (input) => ({ ... }),  // input: { pr: PullRequestRef }
 * };
 * // forget one -> compile error naming the missing tool
 * ```
 */
export interface WireTool<Name extends string = string, Input = any> {
  readonly name: Name;
  readonly input: Input;
}

/**
 * The wire contribution of ONE splice:
 *
 * - an inline {@link ToolImpl} contributes its tool's name + params;
 * - a `Tool<Self>` class splice contributes the same (the tag rides
 *   the requirement channel separately — see `Services`);
 * - a {@link DispatchTool} (door) contributes its name + params;
 * - a nested fragment (raw or effect-valued — nested `AI.prose`, a
 *   component's turn value) contributes ITS tools, recursively, so
 *   conditional branches accumulate: every tool any branch could
 *   mention is on the wire type, whether or not this tick renders it;
 * - everything else (parameters, agents, skills, plain values)
 *   contributes nothing. A skill's tools are encapsulated behind the
 *   skill's own layer, mirroring `Services` — cover them with a
 *   registry for the skill pack, composed alongside the agent's.
 */
export type RefWireTools<R> =
  R extends ToolImpl<infer T, any, any>
    ? T extends Tool<infer Name, infer Refs>
      ? WireTool<Name, ToolParameters<Refs[number]>>
      : never
    : // a Tool<Self> CLASS splice: matched on its identifying members,
      // not the Tool interface itself — `class X extends AI.Tool<X>()(…)`
      // yields a constructor type that drops the interface's call
      // signatures, so a full `extends Tool<…>` never matches a class
      R extends {
          "~alchemy/Kind": "Tool";
          "~alchemy/Name": infer Name extends string;
          refs: infer Refs extends any[];
        }
      ? WireTool<Name, ToolParameters<Refs[number]>>
      : R extends DispatchTool<infer Name, infer Refs>
        ? WireTool<Name, ToolParameters<Refs[number]>>
        : R extends Fragment<infer Refs>
          ? FragmentTools<Refs>
          : R extends Effect.Effect<infer A, any, any>
            ? A extends Fragment<infer Refs>
              ? FragmentTools<Refs>
              : never
            : never;

/** Folds a fragment's splices into its wire-tool union. */
export type FragmentTools<Refs extends ReadonlyArray<unknown>> =
  Refs[number] extends infer A ? RefWireTools<A> : never;

/**
 * The wire-tool union of a full charter (init → turn): tools mentioned
 * by a static fragment, a TURN effect's fragment, or a `TurnFn`'s
 * fragment. Distributes over unions, so a charter whose init returns
 * different turns on different branches accumulates all of them.
 */
export type CharterTools<C> =
  C extends Effect.Effect<infer A, any, any> ? TurnTools<A> : never;

type TurnTools<A> =
  A extends Fragment<infer Refs>
    ? FragmentTools<Refs>
    : A extends Effect.Effect<infer F, any, any>
      ? F extends Fragment<infer Refs>
        ? FragmentTools<Refs>
        : never
      : A extends (input: never) => Effect.Effect<infer F, any, any>
        ? F extends Fragment<infer Refs>
          ? FragmentTools<Refs>
          : never
        : never;

/**
 * A Layer branded (phantom — nothing exists at runtime) with the wire
 * surface of the agent it implements. `Agent.make` returns this, so
 * `typeof SomeAgentLive` is all a UI needs to know every tool that can
 * appear on the transcript.
 */
export interface WiredLayer<
  ROut,
  RIn,
  Tools extends WireTool,
> extends Layer.Layer<ROut, never, RIn> {
  readonly "~alchemy/WireTools"?: Tools;
}

/** The wire-tool union carried by a {@link WiredLayer}. */
export type WireToolsOf<L> = L extends {
  readonly "~alchemy/WireTools"?: (infer T) | undefined;
}
  ? Extract<T, WireTool>
  : never;

/** The tool NAMES on an agent layer's wire — a union of literals. */
export type ToolNames<L> = WireToolsOf<L>["name"];

/** The typed input of one named tool on an agent layer's wire. */
export type ToolInput<L, Name extends ToolNames<L>> = Extract<
  WireToolsOf<L>,
  WireTool<Name & string, any>
>["input"];
