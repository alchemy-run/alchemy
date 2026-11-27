/**
 * An instance with durable callbacks (`Rivet.DurableObjectCallbacks`) and an
 * alarm of its own that re-arms itself. Every delivery counts itself on a
 * counter named after the instance, so a caller sees what ran without waking
 * the instance.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Default } from "./cluster.ts";
import Counter from "./counter.ts";

class Rollback extends Data.TaggedError("Rollback")<{}> {}

export default class Callbacks extends Rivet.DurableObject<Callbacks>()(
  "Callbacks",
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      const record = (what: string) =>
        Effect.asVoid(counters.getByName(`${what}-${state.id.name}`).increment()).pipe(
          Effect.orDie,
        );

      const tick = yield* Alchemy.makeCallback(
        "tick",
        Effect.fn(function* (kind: string) {
          yield* record(kind);
        }),
      );
      // Dies on its first run, then counts every run after.
      const flaky = yield* Alchemy.makeCallback(
        "flaky",
        Effect.fn(function* () {
          const attempts = ((yield* state.storage.get<number>("flaky")) ?? 0) + 1;
          yield* state.storage.put("flaky", attempts).pipe(Effect.orDie);
          if (attempts === 1) return yield* Effect.die("first run dies");
          yield* record("flaky");
        }),
      );

      const now = Effect.sync(() => Date.now());
      return {
        every: () =>
          tick.schedule("every", { every: "1 second", payload: "every" }).pipe(Effect.orDie),
        cron: () =>
          tick.schedule("cron", { cron: "* * * * * *", payload: "cron" }).pipe(Effect.orDie),
        once: (after: number) =>
          tick.schedule("once", { after, payload: "once" }).pipe(Effect.orDie),
        flaky: () =>
          flaky.schedule("flaky", { every: "1 second", payload: undefined }).pipe(Effect.orDie),
        cancel: (id: string) =>
          Effect.gen(function* () {
            yield* tick.cancel(id);
            yield* flaky.cancel(id);
          }).pipe(Effect.orDie),
        status: (id: string) =>
          Effect.map(tick.getStatus(id), (status) => status?.scheduledAt ?? null).pipe(
            Effect.orDie,
          ),
        // A job scheduled in a transaction that rolls back is never kept.
        rolledBack: () =>
          state.storage
            .transaction(
              Effect.gen(function* () {
                yield* tick.schedule("rolled-back", { after: 0, payload: "rolled-back" });
                return yield* new Rollback();
              }),
            )
            .pipe(
              Effect.catchTag("Rollback", () => Effect.void),
              Effect.orDie,
            ),
        // The instance's own alarm, re-armed from inside `alarm()` until it
        // has run `times` times.
        armAlarm: (times: number) =>
          Effect.gen(function* () {
            yield* state.storage.put("alarm-times", times);
            yield* state.storage.setAlarm((yield* now) + 500);
          }),
        onSleep: () => record("slept"),
        alarm: () =>
          Effect.gen(function* () {
            yield* record("alarm");
            const left = ((yield* state.storage.get<number>("alarm-times")) ?? 0) - 1;
            yield* state.storage.put("alarm-times", left);
            if (left > 0) yield* state.storage.setAlarm((yield* now) + 500);
          }).pipe(Effect.orDie),
      };
    }).pipe(Effect.provide(Rivet.DurableObjectCallbacks));
  }).pipe(Effect.provide(Default)),
) {}
