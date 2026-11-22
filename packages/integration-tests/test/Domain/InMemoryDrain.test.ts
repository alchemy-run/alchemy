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

/** Two knocks on one door: the policy runs for each under the door's lock. */
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
/** The first knock's run waits on `gate` holding the lock; the second waits for the lock. */
const answer = (hosted: ReturnType<typeof InMemory.make>, gate: Deferred.Deferred<void>) =>
  Answer.toLayer(
    Effect.gen(function* () {
      const counters = yield* Counter;
      return Effect.fn(function* ({ source, event }) {
        if (event.step === "first") yield* hosted.control.suspended(Deferred.await(gate));
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

  it.live("a run handed a lock is not idle until it has run", () => {
    const hosted = InMemory.make({ manual: true });
    const gate = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const doors = yield* Door;
      const counters = yield* Counter;
      yield* doors.send(new Knock({ id: "d-1", step: "first" }));
      yield* doors.send(new Knock({ id: "d-1", step: "second" }));
      // Both runs start: the first waits on the gate holding the door's lock,
      // the second waits for the lock.
      yield* hosted.control.drain;
      expect(yield* hosted.control.idle).toBe(true);
      expect((yield* counters.get("d-1")).steps).toEqual([]);
      // Open the gate, and wait until the first run has resumed and committed:
      // it is running now, and hands the lock to the second when it finishes.
      const before = hosted.control.commits.length;
      yield* Deferred.succeed(gate, undefined);
      for (let tries = 0; hosted.control.commits.length === before; tries++) {
        expect(tries).toBeLessThan(10_000);
        yield* Effect.yieldNow;
      }
      for (let tries = 0; !(yield* hosted.control.idle); tries++) {
        expect(tries).toBeLessThan(10_000);
        yield* hosted.control.drain;
        yield* Effect.yieldNow;
      }
      expect((yield* counters.get("d-1")).steps).toEqual(["first", "second"]);
    }).pipe(Effect.provide(Doors.layer(answer(hosted, gate)).pipe(Layer.provide(hosted.layer))));
  });
});
