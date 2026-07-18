import type * as Context from "effect/Context";
import type { ToolImpl } from "./Tool.ts";

/**
 * The requirement contributed by a single interpolated ref — its
 * **tag**:
 *
 * - a `Tool<Self>`, `Agent<Self>`, or `Process<Self, Shape>` class is a
 *   `Context.Service`; interpolating it contributes the tag itself.
 *   Transitivity lives in Layer composition, not the type computation:
 *   an agent's tools are requirements of the *agent's Layer*
 *   (`AI.layer(Engineer): Layer<Engineer, never, Kernel | Grep | …>`),
 *   eliminated by `Layer.provide` — which is what lets two agents in
 *   one runtime hold different implementations of the same tool
 *   contract.
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
