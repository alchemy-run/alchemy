import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { makeInputGate, type InputGateShape } from "@/Workers/InputGate.ts";

// A key-value store whose every operation is an async round trip, like
// Rivet's: each one waits a few milliseconds before it settles.
const makeStore = (gate: InputGateShape | undefined) => {
  const values = new Map<string, number>();
  const roundTrip = Effect.promise(
    () => new Promise<void>((resolve) => setTimeout(resolve, Math.random() * 4)),
  );
  const op = <A>(effect: Effect.Effect<A>) => (gate ? gate.storage(effect) : effect);
  return {
    values,
    get: (key: string) => op(Effect.map(roundTrip, () => values.get(key) ?? 0)),
    put: (key: string, value: number) =>
      op(
        Effect.map(roundTrip, () => {
          values.set(key, value);
        }),
      ),
  };
};

type Store = ReturnType<typeof makeStore>;

const increment = (store: Store) =>
  Effect.gen(function* () {
    const count = yield* store.get("count");
    yield* store.put("count", count + 1);
  });

const runCalls = (gate: InputGateShape | undefined, calls: ReadonlyArray<Effect.Effect<void>>) =>
  Effect.forEach(calls, (call) => (gate ? gate.call(call) : call), {
    concurrency: "unbounded",
    discard: true,
  });

describe("InputGate", { tags: ["unit", "local"] }, () => {
  it.live("without a gate, concurrent get-then-put calls lose updates", () =>
    Effect.gen(function* () {
      const store = makeStore(undefined);
      yield* runCalls(
        undefined,
        Array.from({ length: 50 }, () => increment(store)),
      );
      expect(store.values.get("count")).toBeLessThan(50);
    }),
  );

  it.live("keeps a get and a put of one call together", () =>
    Effect.gen(function* () {
      const gate = yield* makeInputGate;
      const store = makeStore(gate);
      yield* runCalls(
        gate,
        Array.from({ length: 50 }, () => increment(store)),
      );
      expect(store.values.get("count")).toBe(50);
    }),
  );

  it.live("keeps them together across a long run of plain code", () =>
    Effect.gen(function* () {
      const gate = yield* makeInputGate;
      const store = makeStore(gate);
      // Thousands of operations between the get and the put: enough that the
      // scheduler would yield the fiber mid-call if the gate let it.
      const busy = Effect.forEach(
        Array.from({ length: 5_000 }, (_, i) => i),
        (i) => Effect.sync(() => i * 2),
        { discard: true },
      );
      const call = Effect.gen(function* () {
        const count = yield* store.get("count");
        yield* busy;
        yield* store.put("count", count + 1);
      });
      yield* runCalls(
        gate,
        Array.from({ length: 20 }, () => call),
      );
      expect(store.values.get("count")).toBe(20);
    }),
  );

  it.live("lets other calls in while one waits on something that isn't storage", () =>
    Effect.gen(function* () {
      const gate = yield* makeInputGate;
      const store = makeStore(gate);
      const order: string[] = [];
      const slow = Effect.gen(function* () {
        yield* store.get("slow");
        yield* Effect.sleep("300 millis");
        yield* store.put("slow", 1);
        order.push("slow");
      });
      const fast = Effect.gen(function* () {
        yield* Effect.sleep("20 millis");
        yield* increment(store);
        order.push("fast");
      });
      yield* runCalls(gate, [slow, fast]);
      expect(order).toEqual(["fast", "slow"]);
    }),
  );

  it.live("shares the gate between the fibers of one call", () =>
    Effect.gen(function* () {
      const gate = yield* makeInputGate;
      const store = makeStore(gate);
      // One call reads two keys in parallel, then writes both.
      const call = Effect.gen(function* () {
        const [a, b] = yield* Effect.all([store.get("a"), store.get("b")], {
          concurrency: "unbounded",
        });
        yield* Effect.all([store.put("a", a + 1), store.put("b", b + 1)], {
          concurrency: "unbounded",
        });
      });
      yield* runCalls(
        gate,
        Array.from({ length: 30 }, () => call),
      );
      expect(store.values.get("a")).toBe(30);
      expect(store.values.get("b")).toBe(30);
    }),
  );

  it.live("holds the gate across an exclusive section, whatever it waits on", () =>
    Effect.gen(function* () {
      const gate = yield* makeInputGate;
      const store = makeStore(gate);
      // The sleep would release an ordinary call's gate; an exclusive
      // section keeps it, so no increment lands between its get and put.
      const transfer = gate.exclusive(
        Effect.gen(function* () {
          const count = yield* store.get("count");
          yield* Effect.sleep("100 millis");
          yield* store.put("count", count + 100);
        }),
      );
      yield* runCalls(gate, [
        transfer,
        ...Array.from({ length: 20 }, () =>
          Effect.andThen(Effect.sleep("10 millis"), increment(store)),
        ),
      ]);
      expect(store.values.get("count")).toBe(120);
    }),
  );

  it.live("runs storage outside any call, and an exclusive section outside one", () =>
    Effect.gen(function* () {
      const gate = yield* makeInputGate;
      const store = makeStore(gate);
      yield* store.put("count", 1);
      yield* gate.exclusive(increment(store));
      expect(store.values.get("count")).toBe(2);
    }),
  );

  it.live("passes the gate on when a waiting call is interrupted", () =>
    Effect.gen(function* () {
      const gate = yield* makeInputGate;
      const store = makeStore(gate);
      const holder = gate.call(
        gate.exclusive(Effect.andThen(store.get("count"), Effect.sleep("100 millis"))),
      );
      const interrupted = gate.call(increment(store)).pipe(Effect.timeout("20 millis"));
      yield* Effect.all([holder, Effect.ignore(interrupted)], { concurrency: "unbounded" });
      // The interrupted waiter left the queue; the gate still works.
      yield* gate.call(increment(store));
      expect(store.values.get("count")).toBe(1);
    }),
  );
});
