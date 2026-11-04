/**
 * Concurrent calls on one instance: plain get-then-put increments, which the
 * input gate keeps from losing updates, transactions, a background loop the
 * constructor starts, and an alarm replaced while it fires.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Default } from "./cluster.ts";

export class TallyAborted extends Data.TaggedError("TallyAborted")<{}> {}

export default class Tally extends Rivet.DurableObject<Tally>()(
  "Tally",
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      const read = (key: string) =>
        Effect.map(state.storage.get<number>(key), (value) => value ?? 0);
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

      return {
        increment,
        read: (key: string) => read(key),
        backgroundDone: () => Effect.sync(() => backgroundDone),
        // Sets an alarm that comes due at once, then holds the gate in a
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
  }).pipe(Effect.provide(Default)),
) {}
