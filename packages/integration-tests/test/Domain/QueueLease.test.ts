/**
 * A queue drain's lease (`DurableObjects.ts`) when the drain that took it
 * died: a policy key's inbox over in-memory storage, on `TestClock`.
 */
import {
  alarmCallbacks,
  ObjectState,
  type ObjectStorage,
  policyObject,
} from "@alchemy.run/domain/DurableObjects";
import type { Delivery, PolicyKit } from "@alchemy.run/domain/Platform";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
 * One policy key's object. Its alarm is a number, as on the hosts; `advance`
 * moves the clock and fires the alarm each time it comes due.
 */
const policyKey = Effect.gen(function* () {
  const storage = memoryStorage();
  const done: Array<number> = [];
  const kit: PolicyKit = {
    name: "Welcome",
    run: (d) =>
      Effect.sync(() => {
        done.push(d.seq);
      }),
  };
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
  const object = yield* policyObject(kit).pipe(
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
  /** Wait for every background drain started so far. */
  const settle = Effect.suspend(() => Fiber.joinAll(background.splice(0)));
  const receive = (d: Delivery) =>
    (object.receive(d) as Effect.Effect<unknown, never, ObjectState>).pipe(
      Effect.provideService(ObjectState, state),
      Effect.andThen(settle),
    );
  const advance = (millis: number) =>
    Effect.gen(function* () {
      const end = (yield* Clock.currentTimeMillis) + millis;
      while (alarm !== null && alarm <= end) {
        yield* TestClock.adjust(Math.max(0, alarm - (yield* Clock.currentTimeMillis)));
        alarm = null;
        yield* callbacks.fire;
        yield* settle;
      }
      yield* TestClock.adjust(end - (yield* Clock.currentTimeMillis));
    });
  return { storage, done, receive, advance };
});

describe("Domain queue lease", { tags: ["unit", "local"] }, () => {
  it.effect("a delivery staged under a dead drain's lease runs once the lease ends", () =>
    Effect.gen(function* () {
      const key = yield* policyKey;
      // A drain took the lease, and its instance died: the lease has 60 s left.
      yield* key.storage.put("inbox-lease", 60_000);
      yield* key.receive(delivery(1));
      expect(key.done).toEqual([]);

      // The 10 s backstop finds the lease still held.
      yield* key.advance(10_000);
      expect(key.done).toEqual([]);

      // The lease has ended: the delivery runs, with no other delivery to start a drain.
      yield* key.advance(50_000);
      expect(key.done).toEqual([1]);
    }),
  );

  it.effect("deliveries staged while the lease is held run in order once it ends", () =>
    Effect.gen(function* () {
      const key = yield* policyKey;
      yield* key.storage.put("inbox-lease", 60_000);
      yield* key.receive(delivery(1));
      yield* key.advance(30_000);
      yield* key.receive(delivery(2));
      yield* key.advance(30_000);
      expect(key.done).toEqual([1, 2]);
      // Nothing is left to run, and the lease is free.
      yield* key.advance(3_600_000);
      expect(key.done).toEqual([1, 2]);
      expect(yield* key.storage.get("inbox-lease")).toBeUndefined();
    }),
  );
});
