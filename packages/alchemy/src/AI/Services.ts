import type * as Context from "effect/Context";
import type { ToolImpl } from "./Tool.ts";

/**
 * The requirement contributed by a single interpolated ref — its
 * **tag**:
 *
 * - a `Tool<Self>`, `Agent<Self>`, `Process<Self, Shape>`, or
 *   `Skill<Self>` class is a `Context.Service`; interpolating it
 *   contributes the tag itself — for a skill that means the SKILL's
 *   tag, never its tools': the bundle is nominal and encapsulated,
 *   and the tool tags surface only as the skill LAYER's own
 *   requirements (`AI.layer(Coding): Layer<Coding, never, Grep | …>`).
 *   Transitivity lives in Layer composition, not the type
 *   computation — which is what lets two agents in one runtime hold
 *   different implementations of the same contract.
 * - a raw `ToolImpl` contributes its implementation's own requirements
 *   (the impl is inline; there is no tag to defer to).
 * - everything else (parameters, plain values) contributes nothing.
 *
 * Interpolation is dependency declaration: mentioning a term in a
 * template is what places it in the dependency graph — and NOT
 * mentioning one is what makes capability-by-omission a type-level
 * fact.
 */
export type RefServices<R> =
  R extends ToolImpl<any, any, infer Req>
    ? Req
    : R extends Context.Service<infer Id, any>
      ? Id
      : never;

/**
 * Folds a term's interpolated expressions into its requirement union
 * (`Req`).
 */
export type Services<Refs extends any[]> = Refs[number] extends infer A
  ? RefServices<A>
  : never;
