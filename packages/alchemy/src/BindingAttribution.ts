/**
 * BINDING ATTRIBUTION — who acquired a binding.
 *
 * `host.bind` rows pool on the target resource (`stack.bindings[fqn]`)
 * with no record of WHICH tool/skill/agent's init acquired them. The
 * ambient attribution path fills that edge: evaluation sites (an
 * agent's charter, a ToolDef's init, a skill's tool physics) run under
 * a stamped path, and `Resource.ts`'s `bind` copies the ambient path
 * onto every row it registers. Deploy identity ignores the path
 * (`dedupeBindings` keys by sid); the raw rows keep it — the
 * permission edges of the org graph, derived from the same plan-phase
 * execution that registers the bindings themselves.
 *
 * Lives in its own module (not `Binding.ts`) because `Resource.ts`
 * must read the ambient path and `Binding.ts` already imports
 * `Resource.ts`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** One step of the org path that led to a binding acquisition. */
export interface AttributionFrame {
  readonly kind: "Agent" | "Skill" | "Tool" | "Group";
  readonly name: string;
}

/**
 * The ambient attribution path — empty outside any stamped evaluation
 * site. A `Context.Reference`, so reading it never charges the
 * requirement channel.
 */
export const Attribution: Context.Reference<ReadonlyArray<AttributionFrame>> =
  Context.Reference("alchemy/Binding/Attribution", {
    defaultValue: (): ReadonlyArray<AttributionFrame> => [],
  });

/** Run `effect` with `frame` appended to the ambient attribution path. */
export const attributed =
  (...frames: ReadonlyArray<AttributionFrame>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Attribution, (path) =>
      Effect.provideService(effect, Attribution, [...path, ...frames]),
    );
