import type * as Context from "effect/Context";
import type { Check } from "./Check.ts";
import type { EventSource } from "./EventSource.ts";
import type { Fold } from "./Fold.ts";
import type { Halt, When } from "./Signature.ts";
import type { ToolImpl } from "./Tool.ts";
import type { Value } from "./Value.ts";

/**
 * The channel tags of any EventSource refs — machine-observed halts or
 * bare event mentions (publish grants): publishing to / observing a
 * channel-backed source needs the channel's physics.
 */
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
 * Requirements contributed by any expression:
 *
 * - signature/control expressions with nested templates — `Halt`
 *   (`AI.until\`…${Bash}…\``), `Fold`, `Check` — contribute their nested
 *   refs' tags (and, for fold/check, the assigned agent's tag);
 * - `When` contributes **nothing** (canon §2: `AI.when` is a pure input
 *   declaration — it types `In`, renders in prose, appears in topology;
 *   delivery is always outside code, so the provisioning compile fence
 *   lives at the consuming call site, not on the process);
 * - a bare `EventSource` mention is the **publish grant** (canon §2a):
 *   it contributes the source's **channel tag** when channel-backed
 *   (publishing needs the channel's physics). The grant is
 *   **owner-sensitive** (ruling 4): a world-owned source (a provider
 *   catalog's, marked `owner: "world"` — its type narrows
 *   `~alchemy/Owner` to the literal) affords nothing by bare mention —
 *   the world publishes it, a process never can — so it contributes no
 *   channel tag. A machine-observed exit on a world source contributes
 *   no channel tag either: the kernel never subscribes the world — the
 *   implementation Layer delivers the exit (`settle(key, event)`);
 * - everything else is a leaf.
 *
 * Nesting is deliberately capped at depth 1: signature/control
 * expressions may contain Tool/Agent/Process refs, but not further
 * signature/control expressions.
 */
export type RefServices<R> =
  R extends Halt<infer Inner, any>
    ? // a machine-observed exit contributes ONLY its nested template
      // refs' tags. Its sources contribute NO channel tag: the kernel
      // never subscribes the world — the exit event is DELIVERED by
      // the implementation Layer (`settle(key, event)`), and the wire's
      // compile fence rides the consuming call site (canon §5:
      // implementations own delivery — exits included)
      LeafServices<Inner[number]>
    : R extends Fold<infer A, infer Inner>
      ? LeafServices<A> | LeafServices<Inner[number]>
      : R extends Check<infer A, infer Inner>
        ? LeafServices<A> | LeafServices<Inner[number]>
        : R extends When<any, any>
          ? // declaration-only: no auto-delivery, no channel obligation
            never
          : R extends EventSource<any, any, any>
            ? // the unmarked mention = the publish grant — unless the
              // source is world-owned (inert vocabulary, no affordance)
              R extends { "~alchemy/Owner": "world" }
              ? never
              : EventChannels<R>
            : // a dynamic-prose Value contributes its resolved-value
              // service's tag (reassess §F): the value is a declared
              // dependency, provided by a Layer
              R extends Value<infer Id>
              ? Id
              : LeafServices<R>;

/**
 * Folds a term's interpolated expressions into its requirement union
 * (`Req`). Interpolation is dependency declaration: mentioning a tool in
 * a template is what places it in the dependency graph.
 */
export type Services<Refs extends any[]> = Refs[number] extends infer A
  ? RefServices<A>
  : never;
