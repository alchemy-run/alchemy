import { Database } from "bun:sqlite";
import {
  makeDurableObjectState,
  migrateStorage,
  runFiredAlarm,
  type ActorContextLike,
} from "@alchemy.run/rivet/DurableObjectState";
import { makeActivation, type Activation } from "@alchemy.run/rivet/internal/Calls";
import { makeSocketRegistry } from "@alchemy.run/rivet/internal/Sockets";
import { describe, expect, it } from "@alchemy.run/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * An actor over an in-memory SQLite database, whose scheduler records what
 * it was asked to run instead of running it.
 */
const makeActor = Effect.promise(async () => {
  const sqlite = new Database(":memory:");
  const scheduled = new Map<string, { at: number; token: unknown }>();
  let next = 0;
  const c: ActorContextLike = {
    key: ["room"],
    db: {
      execute: async <Row extends Record<string, unknown>>(query: string, ...args: unknown[]) =>
        sqlite.query(query).all(...(args as Array<string | number>)) as Row[],
      transaction: () => Promise.reject(new Error("not used")),
    },
    schedule: {
      at: async (at, _action, token) => {
        const id = `schedule-${next++}`;
        scheduled.set(id, { at, token });
        return id;
      },
      cancel: async (id) => scheduled.delete(id),
    },
    waitUntil: () => {},
    keepAwake: (promise) => promise,
    destroy: () => {},
  };
  await migrateStorage(c.db);
  const stateFor = (activation: Activation) =>
    makeDurableObjectState(c, activation, makeSocketRegistry()).storage;
  // RivetKit drops the only schedule due, then calls the alarm action with it.
  const fire = (activation: Activation, handler: Effect.Effect<void, unknown>) =>
    Effect.suspend(() => {
      const [id, due] = [...scheduled].at(0)!;
      scheduled.delete(id);
      return runFiredAlarm(c, activation, due.token, handler);
    });
  return { scheduled, stateFor, fire };
});

describe("Rivet alarms", { tags: ["unit", "provider:rivet"] }, () => {
  it.live("a handler whose node died runs again on the next activation", () =>
    Effect.gen(function* () {
      const actor = yield* makeActor;
      const first = makeActivation();
      yield* actor.stateFor(first).setAlarm(1_000);

      const started = yield* Deferred.make<void>();
      const dying = yield* Effect.forkChild(
        actor.fire(first, Effect.andThen(Deferred.succeed(started, undefined), Effect.never)),
      );
      yield* Deferred.await(started);
      expect(yield* actor.stateFor(first).getAlarm()).toBeNull();
      // The node dies mid-handler: only the lease is left to fire.
      yield* Fiber.interrupt(dying);
      expect(actor.scheduled.size).toBe(1);

      let runs = 0;
      const second = makeActivation();
      yield* actor.fire(
        second,
        Effect.sync(() => void runs++),
      );
      expect(runs).toBe(1);
      expect(yield* actor.stateFor(second).getAlarm()).toBeNull();
      expect(actor.scheduled.size).toBe(0);
    }),
  );

  it.live("a lease that comes due while the handler runs doesn't run it again", () =>
    Effect.gen(function* () {
      const actor = yield* makeActor;
      const activation = makeActivation();
      yield* actor.stateFor(activation).setAlarm(1_000);

      let runs = 0;
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const handler = Effect.gen(function* () {
        runs++;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(finish);
      });
      const running = yield* Effect.forkChild(actor.fire(activation, handler));
      yield* Deferred.await(started);

      yield* actor.fire(activation, handler);
      expect(runs).toBe(1);
      // Renewed, not dropped.
      expect(actor.scheduled.size).toBe(1);

      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(running);
      expect(runs).toBe(1);
      expect(yield* actor.stateFor(activation).getAlarm()).toBeNull();
      expect(actor.scheduled.size).toBe(0);
    }),
  );

  it.live("an alarm the handler sets stands, and the lease is cancelled", () =>
    Effect.gen(function* () {
      const actor = yield* makeActor;
      const activation = makeActivation();
      const storage = actor.stateFor(activation);
      yield* storage.setAlarm(1_000);

      yield* actor.fire(activation, storage.setAlarm(5_000));
      expect(yield* storage.getAlarm()).toBe(5_000);
      expect([...actor.scheduled.values()].map((due) => due.at)).toEqual([5_000]);
    }),
  );

  it.live("a failing handler is retried", () =>
    Effect.gen(function* () {
      const actor = yield* makeActor;
      const activation = makeActivation();
      const storage = actor.stateFor(activation);
      yield* storage.setAlarm(1_000);

      yield* actor.fire(activation, Effect.fail("boom"));
      expect(yield* storage.getAlarm()).not.toBeNull();
      expect(actor.scheduled.size).toBe(1);
    }),
  );
});
