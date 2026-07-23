import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ToolImpl } from "./Tool.ts";

/**
 * The requirement contributed by a single interpolated ref — its
 * **tag** (or, for effect-valued splices, its requirement channel):
 *
 * - a raw `ToolImpl` (an inline, closure-based tool) contributes its
 *   implementation's own requirements — the impl is inline; there is
 *   no tag to defer to.
 * - a `Tool<Self>`, `Agent<Self>`, or `Skill<Self>` class is a
 *   `Context.Service`; interpolating it contributes the tag itself —
 *   for a skill that means the SKILL's tag, never its tools': the
 *   bundle is nominal and encapsulated, and the tool tags surface
 *   only as the skill LAYER's own requirements
 *   (`Coding.make(): Layer<Coding, never, Grep | …>`).
 *   Transitivity lives in Layer composition, not the type
 *   computation — which is what lets two agents in one runtime hold
 *   different implementations of the same contract.
 * - an `Effect` splice (a nested `AI.prose`, a component's turn
 *   value, a `Match` over prose branches) contributes ITS requirement
 *   channel — the `R` union is how conditional branches accumulate:
 *   every capability any branch could mention is a requirement,
 *   whether or not this tick renders it.
 * - everything else (parameters, events, plain values) contributes
 *   nothing.
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
      : R extends Effect.Effect<any, any, infer R2>
        ? R2
        : never;

/**
 * Folds a fragment's interpolated expressions into its requirement
 * union (`Req`).
 */
export type Services<Refs extends any[]> = Refs[number] extends infer A
  ? RefServices<A>
  : never;
