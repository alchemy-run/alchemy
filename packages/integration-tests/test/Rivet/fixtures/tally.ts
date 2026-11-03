/**
 * Concurrent calls on one instance: plain get-then-put increments, which the
 * input gate keeps from losing updates, and transactions.
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
      return {
        increment: (key: string) =>
          Effect.gen(function* () {
            const next = (yield* read(key)) + 1;
            yield* state.storage.put(key, next);
            return next;
          }),
        read: (key: string) => read(key),
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
