import * as PersistentRef from "@/PersistentRef";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

const withStore = (store: PersistentRef.StoreService) =>
  Effect.provideService(PersistentRef.Store, store);

describe("PersistentRef", () => {
  it.effect("get / set / update / modify", () =>
    Effect.gen(function* () {
      const counter = yield* PersistentRef.make("counter", () => 0);
      expect(yield* counter.get).toBe(0);
      yield* counter.set(5);
      yield* counter.update((n) => n + 1);
      const previous = yield* counter.modify((n) => [n, n * 2] as const);
      expect(previous).toBe(6);
      expect(yield* counter.get).toBe(12);
    }).pipe(Effect.provide(PersistentRef.layerMemory)),
  );

  it.effect("persists writes through the store", () =>
    Effect.gen(function* () {
      const rows = new Map<string, unknown>();
      const store = PersistentRef.makeMemoryStore(rows);
      const phase = yield* PersistentRef.make("phase", () => "reproduce").pipe(
        withStore(store),
      );

      // the default is never persisted — an untouched name has no row
      expect(rows.has("phase")).toBe(false);

      yield* phase.set("diagnose");
      expect(rows.get("phase")).toBe("diagnose");
    }),
  );

  it.effect("resumes from persisted state on re-activation", () =>
    Effect.gen(function* () {
      // one durable row map, two store instances = two activations
      const rows = new Map<string, unknown>();

      const first = PersistentRef.makeMemoryStore(rows);
      const phase1 = yield* PersistentRef.make("phase", () => "reproduce").pipe(
        withStore(first),
      );
      yield* phase1.set("report");

      const second = PersistentRef.makeMemoryStore(rows);
      const phase2 = yield* PersistentRef.make("phase", () => "reproduce").pipe(
        withStore(second),
      );
      expect(yield* phase2.get).toBe("report");
    }),
  );

  it.effect("memoizes by name per store instance", () =>
    Effect.gen(function* () {
      const store = PersistentRef.makeMemoryStore();
      const a = yield* PersistentRef.make("shared", () => 1).pipe(
        withStore(store),
      );
      const b = yield* PersistentRef.make("shared", () => 999).pipe(
        withStore(store),
      );
      // same ref: no diverging in-memory caches of one durable row
      expect(b).toBe(a);
      yield* a.set(42);
      expect(yield* b.get).toBe(42);
    }),
  );

  // live clock: the store's simulated latency uses real Effect.delay
  it.live("works with an asynchronous store, writes stay ordered", () =>
    Effect.gen(function* () {
      const rows = new Map<string, unknown>();
      const persisted: Array<unknown> = [];
      // an async store whose FIRST write is slower than its second —
      // FIFO serialization must still land them in call order
      let delay = 30;
      const store: PersistentRef.StoreService = {
        load: (name) => Effect.sync(() => rows.get(name)),
        write: (name, encoded) =>
          Effect.suspend(() => {
            const ms = delay;
            delay = 1;
            return Effect.sync(() => {
              rows.set(name, encoded);
              persisted.push(encoded);
            }).pipe(Effect.delay(ms));
          }),
      };

      const cell = yield* PersistentRef.make("cell", () => 0).pipe(
        withStore(store),
      );
      // two concurrent writes racing through the async store
      const fiber1 = yield* Effect.forkChild(cell.set(1));
      const fiber2 = yield* Effect.forkChild(cell.set(2));
      yield* Fiber.joinAll([fiber1, fiber2]);

      // FIFO serialization: the slow first write cannot clobber the
      // fast second one; memory and storage agree on the last value
      expect(persisted).toEqual([1, 2]);
      expect(rows.get("cell")).toBe(2);
      expect(yield* cell.get).toBe(2);
    }),
  );

  it.effect("round-trips rich values through a schema", () =>
    Effect.gen(function* () {
      const rows = new Map<string, unknown>();
      const schema = Schema.Struct({
        checked: Schema.Number,
        at: Schema.DateFromString,
      });

      const first = PersistentRef.makeMemoryStore(rows);
      const state1 = yield* PersistentRef.make(
        "progress",
        () => ({ checked: 0, at: new Date(0) }),
        { schema },
      ).pipe(withStore(first));
      const at = new Date("2026-08-02T00:00:00Z");
      yield* state1.set({ checked: 3, at });

      // persisted form is the ENCODED side (Date -> ISO string)
      expect((rows.get("progress") as { at: string }).at).toBe(
        at.toISOString(),
      );

      const second = PersistentRef.makeMemoryStore(rows);
      const state2 = yield* PersistentRef.make(
        "progress",
        () => ({ checked: 0, at: new Date(0) }),
        { schema },
      ).pipe(withStore(second));
      const resumed = yield* state2.get;
      expect(resumed.checked).toBe(3);
      expect(resumed.at).toBeInstanceOf(Date);
      expect(resumed.at.getTime()).toBe(at.getTime());
    }),
  );

  it.effect("effectful initial runs only when no row exists", () =>
    Effect.gen(function* () {
      const rows = new Map<string, unknown>();
      let loads = 0;
      const loadCustomer = Effect.sync(() => {
        loads++;
        return { name: "sam", plan: "pro" };
      });

      // first activation: no row — the effect runs once
      const first = PersistentRef.makeMemoryStore(rows);
      const customer1 = yield* PersistentRef.make(
        "customer",
        loadCustomer,
      ).pipe(withStore(first));
      expect(loads).toBe(1);
      expect((yield* customer1.get).name).toBe("sam");
      yield* customer1.set({ name: "sam", plan: "enterprise" });

      // re-activation: the row exists — the effect does NOT run
      const second = PersistentRef.makeMemoryStore(rows);
      const customer2 = yield* PersistentRef.make(
        "customer",
        loadCustomer,
      ).pipe(withStore(second));
      expect(loads).toBe(1);
      expect((yield* customer2.get).plan).toBe("enterprise");

      // memoized re-make in the same activation doesn't run it either
      yield* PersistentRef.make("customer", loadCustomer).pipe(
        withStore(second),
      );
      expect(loads).toBe(1);
    }),
  );

  it.effect("names are independent rows", () =>
    Effect.gen(function* () {
      const store = PersistentRef.makeMemoryStore();
      const a = yield* PersistentRef.make("a", () => 1).pipe(withStore(store));
      const b = yield* PersistentRef.make("b", () => 2).pipe(withStore(store));
      yield* a.set(10);
      expect(yield* b.get).toBe(2);
    }),
  );
});
