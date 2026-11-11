/**
 * Bounded retry of a policy delivery, as the Domain host on Effect Cluster
 * runs it: a policy key's object over in-memory storage, on `TestClock`.
 */
import {
  alarmCallbacks,
  type ObjectStorage,
  ObjectState,
  POLICY_RETRY,
  policyObject,
  type PolicyRetry,
} from "@alchemy.run/domain/DurableObjects";
import type { Delivery, PolicyKit } from "@alchemy.run/domain/Platform";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

/** Storage of one instance, in memory. Keys list in order, as on the hosts. */
const memoryStorage = (): ObjectStorage => {
  const rows = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Effect.sync(() => rows.get(key) as T | undefined),
    put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
      Effect.sync(() => {
        if (typeof keyOrEntries === "string") rows.set(keyOrEntries, value);
        else for (const [key, entry] of Object.entries(keyOrEntries)) rows.set(key, entry);
      })) as ObjectStorage["put"],
    delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
      Effect.sync(() =>
        typeof keyOrKeys === "string"
          ? rows.delete(keyOrKeys)
          : keyOrKeys.filter((key) => rows.delete(key)).length,
      )) as ObjectStorage["delete"],
    list: <T>(options: { prefix?: string; limit?: number } = {}) =>
      Effect.sync(() => {
        const keys = [...rows.keys()]
          .filter((key) => options.prefix === undefined || key.startsWith(options.prefix))
          .sort()
          .slice(0, options.limit ?? Infinity);
        return new Map(keys.map((key) => [key, rows.get(key) as T]));
      }),
    transaction: (effect) => effect,
  };
};

const delivery = (seq: number): Delivery =>
  ({
    target: { kind: "policy", name: "Welcome" },
    key: "a",
    source: "Account/a",
    seq,
    origin: "Account",
    tag: "Opened",
    event: {},
    envelope: {},
  }) as unknown as Delivery;

/**
 * A policy whose run of `poison` always dies; every run is counted, and
 * the seqs that succeeded are kept in order.
 */
const policy = (poison: number) => {
  const runs = new Map<number, number>();
  const done: Array<number> = [];
  const kit: PolicyKit = {
    name: "Welcome",
    run: (d) =>
      Effect.suspend(() => {
        runs.set(d.seq, (runs.get(d.seq) ?? 0) + 1);
        if (d.seq === poison) return Effect.die(new Error("handler bug"));
        done.push(d.seq);
        return Effect.void;
      }),
  };
  return { kit, runs, done };
};

/** One policy key's object, with its background work kept to be joined. */
const policyKey = (kit: PolicyKit, retry: PolicyRetry | undefined) =>
  Effect.gen(function* () {
    const storage = memoryStorage();
    let alarm: number | null = null;
    const callbacks = alarmCallbacks(storage, {
      set: (at) =>
        Effect.sync(() => {
          alarm = at;
        }),
      get: Effect.sync(() => alarm),
    });
    const background: Array<Fiber.Fiber<void>> = [];
    const state = {
      storage,
      exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      waitUntil: (effect: Effect.Effect<void>) =>
        Effect.map(Effect.forkDetach(effect), (fiber) => {
          background.push(fiber);
        }),
    };
    const object = yield* policyObject(kit, retry).pipe(
      Effect.provideService(ObjectState, state),
      Effect.provideService(RuntimeContext, {
        Type: "test",
        id: "test",
        env: {},
        get: () => Effect.void as Effect.Effect<never>,
        set: (id) => Effect.succeed(id),
        makeCallback: callbacks.makeCallback,
      }),
    );
    const receive = (d: Delivery) =>
      (object.receive(d) as Effect.Effect<unknown, never, ObjectState>).pipe(
        Effect.provideService(ObjectState, state),
      );
    /** Wait for every background drain started so far. */
    const settle = Effect.suspend(() => Fiber.joinAll(background.splice(0)));
    return { receive, settle };
  });

/** Error logs, by message. */
const errorLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.make(({ message, logLevel }) => {
    if (logLevel !== "Error") return;
    const text = Array.isArray(message) ? message[0] : message;
    if (typeof text === "string") lines.push(text);
  });
  return { lines, layer: Logger.layer([logger]) };
};

describe("Domain on Effect Cluster: policy retry", { tags: ["local"] }, () => {
  it.effect("a delivery that keeps failing runs 6 times over 31 s, then is logged", () => {
    const logs = errorLogs();
    return Effect.gen(function* () {
      const { kit, runs } = policy(1);
      const key = yield* policyKey(kit, POLICY_RETRY);
      yield* key.receive(delivery(1));

      // The first run, then retries after 1, 2, 4 and 8 seconds.
      yield* TestClock.adjust("15 seconds");
      expect(runs.get(1)).toBe(5);
      expect(logs.lines).toEqual([]);

      // The 5th retry, 16 seconds later, is the last.
      yield* TestClock.adjust("16 seconds");
      yield* key.settle;
      expect(runs.get(1)).toBe(6);
      expect(logs.lines).toEqual(["policy Welcome gave up on delivery Account/a:1 after 6 runs"]);

      // Given up: nothing runs it again.
      yield* TestClock.adjust("1 hour");
      expect(runs.get(1)).toBe(6);
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("the delivery after a given-up one still runs, in order", () =>
    Effect.gen(function* () {
      const { kit, runs, done } = policy(1);
      const key = yield* policyKey(kit, POLICY_RETRY);
      yield* key.receive(delivery(1));
      yield* key.receive(delivery(2));
      yield* key.receive(delivery(3));
      expect(done).toEqual([]);

      yield* TestClock.adjust("31 seconds");
      yield* key.settle;
      expect(runs.get(1)).toBe(6);
      expect(done).toEqual([2, 3]);
    }).pipe(Effect.provide(errorLogs().layer)),
  );

  it.effect("a run that fails once and then succeeds is not given up", () => {
    const logs = errorLogs();
    return Effect.gen(function* () {
      let failures = 1;
      const done: Array<number> = [];
      const kit: PolicyKit = {
        name: "Welcome",
        run: (d) =>
          Effect.suspend(() => {
            if (failures-- > 0) return Effect.die(new Error("blip"));
            done.push(d.seq);
            return Effect.void;
          }),
      };
      const key = yield* policyKey(kit, POLICY_RETRY);
      yield* key.receive(delivery(1));
      yield* TestClock.adjust("1 second");
      yield* key.settle;
      expect(done).toEqual([1]);
      expect(logs.lines).toEqual([]);
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("the schedule and the number of retries are the host's to set", () =>
    Effect.gen(function* () {
      const { kit, runs, done } = policy(1);
      const key = yield* policyKey(kit, {
        schedule: POLICY_RETRY.schedule,
        times: 2,
      });
      yield* key.receive(delivery(1));
      yield* key.receive(delivery(2));
      yield* TestClock.adjust("3 seconds");
      yield* key.settle;
      expect(runs.get(1)).toBe(3);
      expect(done).toEqual([2]);
    }).pipe(Effect.provide(errorLogs().layer)),
  );

  it.effect("without a retry, a failed delivery holds the ones after it", () =>
    Effect.gen(function* () {
      const { kit, runs, done } = policy(1);
      const key = yield* policyKey(kit, undefined);
      yield* key.receive(delivery(1));
      yield* key.receive(delivery(2));
      yield* key.settle;
      yield* TestClock.adjust("1 hour");
      // Each drain stops at it again (each delivery received starts one).
      expect(runs.get(1)).toBe(2);
      expect(done).toEqual([]);
    }),
  );
});
