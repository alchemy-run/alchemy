import * as PersistentRef from "@/PersistentRef";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

const withStore = (store: PersistentRef.StoreService) =>
  Effect.provideService(PersistentRef.Store, store);

describe("PersistentRef", () => {
  it.effect("yield reads; set / update / modify write", () =>
    Effect.gen(function* () {
      const counter = yield* PersistentRef.make("counter", () => 0);
      // the ref IS an Effect<A>: yielding it reads the current value
      expect(yield* counter).toBe(0);
      yield* PersistentRef.set(counter, 5);
      yield* PersistentRef.update(counter, (n) => n + 1);
      const previous = yield* PersistentRef.modify(
        counter,
        (n) => [n, n * 2] as const,
      );
      expect(previous).toBe(6);
      expect(yield* counter).toBe(12);
      expect(yield* PersistentRef.get(counter)).toBe(12);
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

      // writes close over the store resolved at make — no context needed
      yield* PersistentRef.set(phase, "diagnose");
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
      yield* PersistentRef.set(phase1, "report");

      const second = PersistentRef.makeMemoryStore(rows);
      const phase2 = yield* PersistentRef.make("phase", () => "reproduce").pipe(
        withStore(second),
      );
      expect(yield* phase2).toBe("report");
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
      yield* PersistentRef.set(a, 42);
      expect(yield* b).toBe(42);
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
        load: (key) => Effect.sync(() => rows.get(PersistentRef.pathKey(key))),
        write: (key, encoded) =>
          Effect.suspend(() => {
            const ms = delay;
            delay = 1;
            return Effect.sync(() => {
              rows.set(PersistentRef.pathKey(key), encoded);
              persisted.push(encoded);
            }).pipe(Effect.delay(ms));
          }),
      };

      const cell = yield* PersistentRef.make("cell", () => 0).pipe(
        withStore(store),
      );
      // two concurrent writes racing through the async store
      const fiber1 = yield* Effect.forkChild(PersistentRef.set(cell, 1));
      const fiber2 = yield* Effect.forkChild(PersistentRef.set(cell, 2));
      yield* Fiber.joinAll([fiber1, fiber2]);

      // FIFO serialization: the slow first write cannot clobber the
      // fast second one; memory and storage agree on the last value
      expect(persisted).toEqual([1, 2]);
      expect(rows.get("cell")).toBe(2);
      expect(yield* cell).toBe(2);
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
      expect((yield* customer1).name).toBe("sam");
      yield* PersistentRef.set(customer1, { name: "sam", plan: "enterprise" });

      // re-activation: the row exists — the effect does NOT run
      const second = PersistentRef.makeMemoryStore(rows);
      const customer2 = yield* PersistentRef.make(
        "customer",
        loadCustomer,
      ).pipe(withStore(second));
      expect(loads).toBe(1);
      expect((yield* customer2).plan).toBe("enterprise");

      // memoized re-make in the same activation doesn't run it either
      yield* PersistentRef.make("customer", loadCustomer).pipe(
        withStore(second),
      );
      expect(loads).toBe(1);
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
      yield* PersistentRef.set(state1, { checked: 3, at });

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
      const resumed = yield* state2;
      expect(resumed.checked).toBe(3);
      expect(resumed.at).toBeInstanceOf(Date);
      expect(resumed.at.getTime()).toBe(at.getTime());
    }),
  );

  it.effect("names are independent rows", () =>
    Effect.gen(function* () {
      const store = PersistentRef.makeMemoryStore();
      const a = yield* PersistentRef.make("a", () => 1).pipe(withStore(store));
      const b = yield* PersistentRef.make("b", () => 2).pipe(withStore(store));
      yield* PersistentRef.set(a, 10);
      expect(yield* b).toBe(2);
    }),
  );

  describe("namespacing", () => {
    it.effect("two runs, one shared store, disjoint rows", () =>
      Effect.gen(function* () {
        const rows = new Map<string, unknown>();
        const store = PersistentRef.makeMemoryStore(rows);
        // the host's frame: what a driver wraps around each run — run
        // keys are arbitrary strings, "/" and "#" included
        const inRun = (key: string) => PersistentRef.within("IssueOwner", key);

        const a = yield* PersistentRef.make("phase", () => "start").pipe(
          inRun("sam-goodwin/test-alchemy#1"),
          withStore(store),
        );
        const b = yield* PersistentRef.make("phase", () => "start").pipe(
          inRun("sam-goodwin/test-alchemy#2"),
          withStore(store),
        );

        yield* PersistentRef.set(a, "done");
        expect(yield* b).toBe("start");

        // the memory store's mapping is pathKey: escaped, path-shaped
        expect(rows.get("IssueOwner/sam-goodwin%2Ftest-alchemy#1/phase")).toBe(
          "done",
        );
      }),
    );

    it.effect("within isolates library state from the charter's", () =>
      Effect.gen(function* () {
        const store = PersistentRef.makeMemoryStore();
        const frame = PersistentRef.within("Engineer", "o/r#7");

        const charter = yield* PersistentRef.make("progress", () => 0).pipe(
          frame,
          withStore(store),
        );
        const library = yield* PersistentRef.make("progress", () => 0).pipe(
          PersistentRef.within("coding"),
          frame,
          withStore(store),
        );

        yield* PersistentRef.set(charter, 5);
        expect(yield* library).toBe(0);
      }),
    );

    it.effect("chains nest and memoization keys on the full path", () =>
      Effect.gen(function* () {
        const rows = new Map<string, unknown>();
        const store = PersistentRef.makeMemoryStore(rows);

        const nested = yield* PersistentRef.make("x", () => "deep").pipe(
          PersistentRef.within("b"),
          PersistentRef.within("a"),
          withStore(store),
        );
        yield* PersistentRef.set(nested, "written");
        expect(rows.get("a/b/x")).toBe("written");

        // same path = same memoized ref; sibling path = a different one
        const same = yield* PersistentRef.make("x", () => "?").pipe(
          PersistentRef.within("a", "b"),
          withStore(store),
        );
        expect(same).toBe(nested);
        const sibling = yield* PersistentRef.make("x", () => "?").pipe(
          PersistentRef.within("a", "c"),
          withStore(store),
        );
        expect(sibling).not.toBe(nested);
      }),
    );

    it.effect("tuple identity: no segment/name joining ambiguity", () =>
      Effect.gen(function* () {
        const store = PersistentRef.makeMemoryStore();
        // ["a/b"] and ["a","b"] are DIFFERENT identities even though a
        // naive join would collide — pathKey escapes the "/" inside
        const joined = yield* PersistentRef.make("x", () => 1).pipe(
          PersistentRef.within("a/b"),
          withStore(store),
        );
        const split = yield* PersistentRef.make("x", () => 1).pipe(
          PersistentRef.within("a", "b"),
          withStore(store),
        );
        expect(split).not.toBe(joined);
        yield* PersistentRef.set(joined, 100);
        expect(yield* split).toBe(1);
      }),
    );
  });
});
