/**
 * Cloudflare's input gate, for Durable Object engines whose storage is
 * asynchronous.
 *
 * On Cloudflare, a Durable Object's calls interleave whenever one waits on
 * something, but never around storage: while a storage operation is in
 * flight no other call proceeds, so a `get` followed by a `put`, with only
 * plain code between them, can't lose an update. An engine that runs calls
 * concurrently over async storage (Rivet) loses that guarantee. This gate
 * restores it.
 *
 * The gate is held by a call, not a fiber: every fiber a call forks shares
 * it. A call takes the gate at its first storage operation and keeps it
 * while it keeps doing storage. Once it waits on anything else (a `fetch`,
 * another Durable Object, a sleep), the gate passes to the next call
 * waiting for storage. Calls still overlap while they wait on the outside
 * world; they only line up around storage.
 *
 * The bridge runs each request, each alarm and the instance's construction
 * as a call. Work a call hands to `waitUntil` and fibers it forks stay part
 * of it after it returns, so a background loop started by the constructor
 * is gated as one long call.
 *
 * It's opt-in: provide the {@link InputGate} Layer (`Workers.InputGate`,
 * from `alchemy/Workers`) to a Durable Object
 * class's outer Effect, and the Durable Object bridge gives each of its
 * instances a gate. Storage goes through the gate where the engine wraps
 * its operations in {@link gateStorage}. Cloudflare has a gate of its own,
 * so it's for engines without one (Rivet).
 *
 * @module
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import { CurrentRuntimeContext } from "../RuntimeContext.ts";

export interface InputGateShape {
  /**
   * Run one call. The call's fibers share one place in the gate, and the
   * call never yields to the scheduler on its own, so a `get` and a `put`
   * separated by plain code stay together.
   */
  readonly call: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Run one storage operation. Waits while another call holds the gate,
   * then holds it until the call next waits on something that isn't
   * storage.
   */
  readonly storage: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Hold the gate for the whole of `effect`, whatever it waits on (a
   * transaction). A call made back into this instance from inside waits
   * until `effect` finishes, so don't call out from it.
   */
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** One Durable Object instance's input gate. */
export class InstanceInputGate extends Context.Service<InstanceInputGate, InputGateShape>()(
  "alchemy/Workers/InstanceInputGate",
) {}

/** The call a fiber belongs to; forked fibers inherit it. */
const CurrentCall = Context.Reference<number | undefined>("alchemy/Workers/InputGate/CurrentCall", {
  defaultValue: () => undefined,
});

interface Waiter {
  readonly call: number;
  readonly resume: (effect: Effect.Effect<void>) => void;
  granted: boolean;
}

/** Build a gate for one instance. */
export const makeInputGate: Effect.Effect<InputGateShape> = Effect.sync(() => {
  let nextCall = 0;
  // The call that may touch storage now.
  let holder: number | undefined;
  // The holder's storage operations (and exclusive sections) in flight.
  let pending = 0;
  let exclusive = 0;
  let checking = false;
  const waiters: Waiter[] = [];

  // Hand the gate to the longest-waiting call, with every one of its fibers
  // that's waiting too.
  const release = () => {
    holder = undefined;
    const next = waiters[0];
    if (next === undefined) return;
    holder = next.call;
    for (let i = 0; i < waiters.length;) {
      const waiter = waiters[i]!;
      if (waiter.call !== holder) {
        i++;
        continue;
      }
      waiters.splice(i, 1);
      // Counted now, so the release check can't pass the gate on before the
      // waiter's fiber resumes.
      waiter.granted = true;
      pending++;
      waiter.resume(Effect.void);
    }
  };

  // After a storage operation finishes, its call either starts another one
  // in the same run of plain code, or suspends on something else. Check on
  // the next macrotask, after that run, which it was.
  const scheduleCheck = () => {
    if (checking) return;
    checking = true;
    setImmediate(() => {
      checking = false;
      if (holder !== undefined && pending === 0 && exclusive === 0) release();
    });
  };

  const done = Effect.sync(() => {
    pending--;
    scheduleCheck();
  });

  // Take the gate for `call`, counting one operation in flight.
  const acquire = (call: number) =>
    Effect.callback<void>((resume) => {
      if (holder === undefined || holder === call) {
        holder = call;
        pending++;
        resume(Effect.void);
        return;
      }
      const waiter: Waiter = { call, resume, granted: false };
      waiters.push(waiter);
      return Effect.sync(() => {
        // Interrupted while waiting: leave the queue, or give back the turn
        // it was granted.
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        else if (waiter.granted) {
          pending--;
          scheduleCheck();
        }
      });
    });

  // Storage outside any call (an engine that doesn't run construction
  // through `call`) counts as a call of its own per operation.
  const currentCall = Effect.gen(function* () {
    return (yield* CurrentCall) ?? nextCall++;
  });

  return {
    call: (effect) =>
      Effect.suspend(() =>
        effect.pipe(
          Effect.provideService(CurrentCall, nextCall++),
          Effect.provideService(Scheduler.PreventSchedulerYield, true),
        ),
      ),
    // Both pass the call down, so storage nested inside (an exclusive
    // section's operations) belongs to the same call.
    storage: (effect) =>
      Effect.flatMap(currentCall, (call) =>
        Effect.flatMap(acquire(call), () =>
          Effect.ensuring(Effect.provideService(effect, CurrentCall, call), done),
        ),
      ),
    exclusive: (effect) =>
      Effect.flatMap(currentCall, (call) =>
        Effect.flatMap(acquire(call), () =>
          Effect.suspend(() => {
            exclusive++;
            return Effect.ensuring(
              Effect.provideService(effect, CurrentCall, call),
              Effect.sync(() => {
                exclusive--;
              }).pipe(Effect.andThen(done)),
            );
          }),
        ),
      ),
  };
});

/**
 * Cloudflare's input gate, for a Durable Object on an engine without one.
 *
 * Without it, an instance's calls run fully in parallel, storage included:
 * make a change atomic with a transaction. Provide it to a class's outer
 * Effect and each instance gets its own gate, so storage behaves as on
 * Cloudflare: while one call does storage, no other call's storage runs,
 * and a `get` followed by a `put`, with only plain code between them, can't
 * lose an update. Calls still overlap while they wait on anything else.
 *
 * Each storage operation then waits its turn, so give it to code written
 * for Cloudflare's gate, and use transactions everywhere else.
 *
 * ### Running Cloudflare code unchanged
 * **Example:** A get-then-put counter on Rivet that loses no updates
 * ```typescript
 * import * as Workers from "alchemy/Workers";
 *
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
 *   }).pipe(Effect.provide(Layer.mergeAll(Default, Workers.InputGate))),
 * ) {}
 * ```
 */
export const InputGate: Layer.Layer<never> = Layer.effectDiscard(
  Effect.gen(function* () {
    const ctx = yield* CurrentRuntimeContext;
    if (ctx !== undefined) ctx.inputGate = true;
  }),
);

/** Run one call through the instance's gate, when it has one. */
export const gateCall = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(InstanceInputGate), (gate) =>
    Option.isSome(gate) ? gate.value.call(effect) : effect,
  );

/** Run one storage operation through the instance's gate, when it has one. */
export const gateStorage = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(InstanceInputGate), (gate) =>
    Option.isSome(gate) ? gate.value.storage(effect) : effect,
  );

/** Hold the instance's gate for the whole of `effect`, when it has one. */
export const gateExclusive = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(InstanceInputGate), (gate) =>
    Option.isSome(gate) ? gate.value.exclusive(effect) : effect,
  );
