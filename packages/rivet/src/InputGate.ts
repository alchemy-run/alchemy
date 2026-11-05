import { Self } from "alchemy/Self";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  DurableObjectTypeId,
  type DurableObject,
  type DurableObjectRuntimeContext,
} from "./DurableObject.ts";

/** `Rivet.InputGate` was provided to something other than a `Rivet.DurableObject`. */
export class InputGateOutsideDurableObject extends Data.TaggedError(
  "Rivet.InputGateOutsideDurableObject",
)<{
  readonly message: string;
}> {}

/**
 * Cloudflare's input gate, for a `Rivet.DurableObject`.
 *
 * Without it, an instance's calls run fully in parallel, storage included.
 * Make a change atomic with `state.storage.transaction(...)`.
 *
 * Provide it to a class's outer Effect, next to its pool, and every
 * instance of the class gets its own gate. Storage then behaves as on
 * Cloudflare: while one call does storage, no other call's storage runs, so
 * a `get` followed by a `put`, with only plain code between them, can't
 * lose an update. Calls still overlap while they wait on anything else (a
 * `fetch`, another Durable Object, a sleep).
 *
 * Every storage operation on Rivet is a round trip, so the gate limits an
 * instance to one storage operation at a time across all its calls. Give it
 * to code written for Cloudflare that relies on the gate, and use
 * transactions everywhere else.
 *
 * ### Running Cloudflare code unchanged
 * **Example:** A get-then-put counter that loses no updates
 * ```typescript
 * export default class Counter extends Rivet.DurableObject<Counter>()(
 *   "Counter",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const state = yield* Rivet.DurableObjectState;
 *       return {
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const count = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
 *             yield* state.storage.put("count", count);
 *             return count;
 *           }),
 *       };
 *     });
 *   }).pipe(Effect.provide(Layer.mergeAll(Default, Rivet.InputGate))),
 * ) {}
 * ```
 *
 * @layer
 * @product Rivet
 */
export const InputGate: Layer.Layer<never> = Layer.effectDiscard(
  Effect.gen(function* () {
    // The class whose phase is running, as for a pool Layer.
    const self = Option.getOrUndefined(yield* Effect.serviceOption(Self));
    if (self === undefined || self.Type !== DurableObjectTypeId) {
      return yield* Effect.die(
        new InputGateOutsideDurableObject({
          message:
            self === undefined
              ? "Rivet.InputGate was provided outside a Rivet.DurableObject."
              : `Rivet.InputGate was provided to ${self.Type} '${self.LogicalId}', not a Rivet.DurableObject.`,
        }),
      );
    }
    yield* (self as unknown as DurableObject & DurableObjectRuntimeContext).useInputGate();
  }),
);
