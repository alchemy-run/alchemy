import type * as Context from "effect/Context";
import type { Check } from "./Check.ts";
import type { EventSource } from "./EventSource.ts";
import type { Fold } from "./Fold.ts";
import type { Halt } from "./Halt.ts";
import type { ToolImpl } from "./Tool.ts";
import type { Trigger } from "./Trigger.ts";
import type { Value } from "./Value.ts";

/** The channel tags of any EventSource refs (machine-observed halts). */
type EventChannels<R> =
  R extends EventSource<any, infer Channel, any>
    ? [Channel] extends [never]
      ? never
      : Channel
    : never;

/**
 * The requirement contributed by a single leaf ref — its **tag**:
 *
 * - a `Tool<Self>`, `Agent<Self>`, or `Process<Self>` class is a
 *   `Context.Service`; interpolating it contributes the tag itself.
 *   Transitivity moved out of the type computation and into Layer
 *   composition: an agent's tools are requirements of the *agent's Layer*
 *   (`AI.layer(Engineer): Layer<Engineer, never, Kernel | Grep | …>`),
 *   eliminated by `Layer.provide` — which is what lets two agents in one
 *   runtime hold different implementations of the same tool contract.
 * - a raw `ToolImpl` contributes its implementation's own requirements
 *   (the impl is inline; there is no tag to defer to).
 *
 * `Observe` refs deliberately match no arm: observation grants trace
 * access, not capabilities.
 */
type LeafServices<R> =
  R extends ToolImpl<any, any, infer Req>
    ? Req
    : R extends Context.Service<infer Id, any>
      ? Id
      : never;

/**
 * Requirements contributed by any ref:
 *
 * - control refs with nested templates — `Halt` (`AI.until\`…${Bash}…\``),
 *   `Fold`, `Check` — contribute their nested refs' tags (and, for
 *   fold/check, the assigned agent's tag);
 * - `Trigger` contributes its event sources' **channel tags** — the
 *   services a harness must provide to deliver those events (e.g. a
 *   `GitHubEvents` channel implemented by webhook provisioning + routing);
 * - everything else is a leaf.
 *
 * Nesting is deliberately capped at depth 1: control refs may contain
 * Tool/Agent/Process refs, but not further control refs.
 */
export type RefServices<R> =
  R extends Halt<infer Inner, any>
    ?
        // a machine-observed halt (`AI.until(source)`) carries its exit
        // EventSource in refs — its channel tag must join Req, exactly like
        // a trigger's (reassess §B)
        LeafServices<Inner[number]> | EventChannels<Inner[number]>
    : R extends Fold<infer A, infer Inner>
      ? LeafServices<A> | LeafServices<Inner[number]>
      : R extends Check<infer A, infer Inner>
        ? LeafServices<A> | LeafServices<Inner[number]>
        : R extends Trigger<any, infer Channels>
          ? Channels
          : // a dynamic-prose Value contributes its resolved-value
            // service's tag (reassess §F): the value is a declared
            // dependency, provided by a Layer
            R extends Value<infer Id>
            ? Id
            : LeafServices<R>;

/**
 * Folds a term's interpolated refs into its requirement union (`Req`).
 * Interpolation is dependency declaration: mentioning a tool in a template
 * is what places it in the dependency graph.
 */
export type Services<Refs extends any[]> = Refs[number] extends infer A
  ? RefServices<A>
  : never;
