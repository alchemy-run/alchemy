/**
 * Concurrent calls on one instance: plain get-then-put increments, which
 * only an input gate keeps from losing updates, transactional increments,
 * which never lose one, a background loop the constructor starts, a burst
 * of storage another call's storage can or can't overlap, and an alarm
 * replaced while it fires.
 *
 * `Tally` runs its calls fully in parallel; `GatedTally` (gated-tally.ts)
 * is the same class given `Workers.InputGate`.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Default } from "./cluster.ts";

export class TallyAborted extends Data.TaggedError("TallyAborted")<{}> {}

/** The class phase both classes share; each provides its own Layers. */
export const TallyImpl = Effect.gen(function* () {
  return Effect.gen(function* () {
    const state = yield* Rivet.DurableObjectState;
    const read = (key: string) => Effect.map(state.storage.get<number>(key), (value) => value ?? 0);
    const increment = (key: string) =>
      Effect.gen(function* () {
        const next = (yield* read(key)) + 1;
        yield* state.storage.put(key, next);
        return next;
      });

    // 50 increments of "background" from a fiber the constructor forks,
    // racing calls that increment it too.
    let backgroundDone = false;
    yield* Effect.forkDetach(
      Effect.forEach(
        Array.from({ length: 50 }),
        () => Effect.andThen(increment("background"), Effect.sleep("5 millis")),
        { discard: true },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            backgroundDone = true;
          }),
        ),
      ),
    );

    // How many of `burst`'s reads have finished.
    let burstDone = 0;

    return {
      increment,
      // The same increment, atomic with or without a gate.
      incrementInTransaction: (key: string) => state.storage.transaction(increment(key)),
      // `n` writes back to back, with only plain code between them.
      burst: (n: number) =>
        Effect.gen(function* () {
          for (let i = 0; i < n; i++) {
            yield* state.storage.put("burst", i);
            burstDone++;
          }
          return burstDone;
        }),
      // Once `burst` has started, one read: how many of the burst's writes
      // had finished when it did. Behind a gate, all of them.
      probe: () =>
        Effect.gen(function* () {
          yield* Effect.sync(() => burstDone).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 millis"),
              until: (done) => done > 0,
              times: 5_000,
            }),
          );
          yield* state.storage.get("probe");
          return burstDone;
        }),
      read: (key: string) => read(key),
      backgroundDone: () => Effect.sync(() => backgroundDone),
      // Sets an alarm that comes due at once, then holds storage in a
      // transaction while RivetKit fires it, and replaces it from there.
      // The fired alarm must neither run `alarm` nor clear the new one.
      replaceFiringAlarm: () =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => Date.now());
          yield* state.storage.setAlarm(now + 500);
          yield* state.storage.transaction(
            Effect.gen(function* () {
              yield* Effect.sleep("2 seconds");
              yield* state.storage.setAlarm(now + 600_000);
            }),
          );
        }),
      alarmState: () =>
        Effect.gen(function* () {
          return { fired: yield* read("fired"), alarm: yield* state.storage.getAlarm() };
        }),
      alarm: () => Effect.asVoid(increment("fired")),
      // Adds `amount`, waiting `waitMs` between the read and the write. The
      // transaction keeps every other call's storage out meanwhile.
      addSlowly: (key: string, amount: number, waitMs: number) =>
        state.storage.transaction(
          Effect.gen(function* () {
            const value = yield* read(key);
            yield* Effect.sleep(waitMs);
            yield* state.storage.put(key, value + amount);
          }),
        ),
      // Writes, then fails: the write rolls back.
      addThenAbort: (key: string, amount: number) =>
        state.storage.transaction(
          Effect.gen(function* () {
            yield* state.storage.put(key, (yield* read(key)) + amount);
            return yield* Effect.fail(new TallyAborted());
          }),
        ),
    };
  });
});

export default class Tally extends Rivet.DurableObject<Tally>()(
  "Tally",
  { main: import.meta.url },
  TallyImpl.pipe(Effect.provide(Default)),
) {}
