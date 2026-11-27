import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";

// A run another run wakes (its saga turn given, or a lock handed over) counts
// as running from the moment it is woken. Until its fiber resumes, it must not
// count as waiting: `drain` would return, and `idle` say `true`, before it runs.
// Nor may another run take the lock handed to it in the meantime.

class Started extends Domain.Event("Started") {}
class Stepped extends Domain.Event("Stepped", { step: Schema.String }) {}
class Start extends Domain.Command("Start", {
  input: { id: Schema.String },
  events: [Started],
}) {}
class Step extends Domain.Command("Step", {
  input: { id: Schema.String, step: Schema.String },
  events: [Stepped],
}) {}

class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ steps: Schema.Array(Schema.String) }),
  initial: { steps: [] },
  commands: [Start, Step],
  keyOf: (command) => command.id,
  decide: {
    Start: () => [new Started()],
    Step: (_, cmd) => [new Stepped({ step: cmd.step })],
  },
  evolve: {
    Started: (s) => s,
    Stepped: (s, e) => ({ steps: [...s.steps, e.step] }),
  },
}) {}

/** Two Activities: with `manual`, the second waits for its turn in the queue. */
class TwoSteps extends Domain.Saga("TwoSteps", { key: Schema.String, input: {} }) {}
class StartTwoSteps extends Domain.Policy("StartTwoSteps", { from: Counter, on: [Started] }) {}
const TwoStepsLive = Layer.mergeAll(
  StartTwoSteps.toLayer(
    Effect.gen(function* () {
      const sagas = yield* TwoSteps;
      return Effect.fn(function* ({ source }) {
        yield* sagas.start(source.id, {});
      });
    }),
  ),
  TwoSteps.toLayer(
    Effect.gen(function* () {
      const counters = yield* Counter;
      return Effect.fn(function* ({ key }) {
        for (const step of ["one", "two"]) {
          yield* Activity.make({
            name: step,
            execute: counters.send(new Step({ id: key, step })).pipe(Effect.orDie),
          });
        }
      });
    }),
  ),
);
class Sagas extends Domain.Model("DrainSagas", {
  aggregates: [Counter],
  policies: [StartTwoSteps],
  sagas: [TwoSteps],
}) {}

/** Knocks on one door: the policy runs for each under the door's lock. */
class Knocked extends Domain.Event("Knocked", { step: Schema.String }) {}
class Knock extends Domain.Command("Knock", {
  input: { id: Schema.String, step: Schema.String },
  events: [Knocked],
}) {}
class Door extends Domain.Aggregate("Door", {
  id: Schema.String,
  state: Schema.Struct({ knocks: Schema.Number }),
  initial: { knocks: 0 },
  commands: [Knock],
  keyOf: (command) => command.id,
  decide: { Knock: (_, cmd) => [new Knocked({ step: cmd.step })] },
  evolve: { Knocked: (s) => ({ knocks: s.knocks + 1 }) },
}) {}
class Answer extends Domain.Policy("Answer", { from: Door, on: [Knocked] }) {}
/** A knock whose step has a gate waits on it, holding the lock. */
const answer = (
  hosted: ReturnType<typeof InMemory.make>,
  gates: Record<string, Deferred.Deferred<void>>,
) =>
  Answer.toLayer(
    Effect.gen(function* () {
      const counters = yield* Counter;
      return Effect.fn(function* ({ source, event }) {
        const gate = gates[event.step];
        if (gate) yield* hosted.control.suspended(Deferred.await(gate));
        yield* counters.send(new Step({ id: source.id, step: event.step })).pipe(Effect.orDie);
      });
    }),
  );
class Doors extends Domain.Model("DrainDoors", {
  aggregates: [Door, Counter],
  policies: [Answer],
}) {}

describe("Domain InMemory: drain", { tags: ["unit", "local"] }, () => {
  it.live("one drain runs every Activity of a saga, each waiting for its turn", () =>
    Effect.forEach(
      // the early return was not a rare race: it happened on every try
      Array.from({ length: 5 }, (_, i) => `c-${i}`),
      (id) => {
        const hosted = InMemory.make({ manual: true });
        return Effect.gen(function* () {
          const counters = yield* Counter;
          yield* counters.send(new Start({ id }));
          yield* hosted.control.drain;
          expect(yield* hosted.control.idle).toBe(true);
          expect((yield* counters.get(id)).steps).toEqual(["one", "two"]);
        }).pipe(Effect.provide(Sagas.layer(TwoStepsLive).pipe(Layer.provide(hosted.layer))));
      },
      { discard: true },
    ),
  );

  it.live("a run handed a lock runs before a later one, and is not idle until it has run", () =>
    Effect.forEach(
      // The third knock's run asks for the lock about when the first run hands
      // it to the second; how close depends on `wait`, so try a few, in both modes.
      [true, false].flatMap((manual) => Array.from({ length: 5 }, (_, wait) => ({ manual, wait }))),
      ({ manual, wait }) => {
        const hosted = InMemory.make({ manual });
        const first = Deferred.makeUnsafe<void>();
        const third = Deferred.makeUnsafe<void>();
        const until = (done: Effect.Effect<boolean>) =>
          Effect.gen(function* () {
            for (let tries = 0; !(yield* done); tries++) {
              expect(tries).toBeLessThan(10_000);
              yield* hosted.control.drain;
              yield* Effect.yieldNow;
            }
          });
        const committed = (count: number) =>
          until(Effect.sync(() => hosted.control.commits.length >= count));
        return Effect.gen(function* () {
          const doors = yield* Door;
          const counters = yield* Counter;
          // The first run waits on its gate holding the door's lock; the second
          // waits for the lock.
          yield* doors.send(new Knock({ id: "d-1", step: "first" }));
          yield* doors.send(new Knock({ id: "d-1", step: "second" }));
          yield* until(hosted.control.idle);
          expect((yield* counters.get("d-1")).steps).toEqual([]);
          yield* doors.send(new Knock({ id: "d-1", step: "third" }));
          const before = hosted.control.commits.length;
          for (let i = 0; i < wait; i++) yield* Effect.yieldNow;
          // Once the first run has committed, it hands the lock to the second,
          // which runs before the third, and counts as running until it has.
          yield* Deferred.succeed(first, undefined);
          yield* committed(before + 1);
          yield* until(hosted.control.idle);
          expect((yield* counters.get("d-1")).steps).toEqual(["first", "second"]);
          yield* Deferred.succeed(third, undefined);
          yield* committed(before + 3);
          expect((yield* counters.get("d-1")).steps).toEqual(["first", "second", "third"]);
        }).pipe(
          Effect.provide(
            Doors.layer(answer(hosted, { first, third })).pipe(Layer.provide(hosted.layer)),
          ),
        );
      },
      { discard: true },
    ),
  );
});
