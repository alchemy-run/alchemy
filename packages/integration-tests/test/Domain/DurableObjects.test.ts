import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

// ---------------------------------------------------------------- an in-process Durable Object host

/** Rows the objects of one host read from storage. */
interface Stats {
  rowsRead: number;
}

/** Sorted key-value storage that counts the rows it reads, as Durable Object billing does. */
const makeStorage = (stats: Stats): DurableObjects.ObjectStorage => {
  let data = new Map<string, unknown>();
  const sortedKeys = () => [...data.keys()].sort();
  const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
  const storage: DurableObjects.ObjectStorage = {
    get: <T>(key: string) =>
      Effect.sync(() => {
        stats.rowsRead += 1;
        return clone(data.get(key) as T | undefined);
      }),
    put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
      Effect.sync(() => {
        if (typeof keyOrEntries === "string") data.set(keyOrEntries, clone(value));
        else for (const [key, entry] of Object.entries(keyOrEntries)) data.set(key, clone(entry));
      })) as DurableObjects.ObjectStorage["put"],
    delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
      Effect.sync(() => {
        if (typeof keyOrKeys === "string") return data.delete(keyOrKeys);
        return keyOrKeys.filter((key) => data.delete(key)).length;
      })) as DurableObjects.ObjectStorage["delete"],
    list: <T>(options: DurableObjects.ListOptions = {}) =>
      Effect.sync(() => {
        let keys = sortedKeys().filter(
          (key) =>
            (options.prefix === undefined || key.startsWith(options.prefix)) &&
            (options.start === undefined || key >= options.start) &&
            (options.startAfter === undefined || key > options.startAfter) &&
            (options.end === undefined || key < options.end),
        );
        if (options.reverse) keys.reverse();
        if (options.limit !== undefined) keys = keys.slice(0, options.limit);
        stats.rowsRead += keys.length;
        return new Map(keys.map((key) => [key, clone(data.get(key) as T)]));
      }),
    // Writes inside commit together: a failure restores what was there before.
    transaction: (effect) =>
      Effect.suspend(() => {
        const before = new Map(data);
        return effect.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() => {
                  data = before;
                })
              : Effect.void,
          ),
        );
      }),
  };
  return storage;
};

/**
 * Objects run in this process: one instance per name, built on its first
 * call, with storage that counts rows read and one alarm for its callbacks.
 * Calls cross a JSON boundary, as Workers RPC does.
 */
const simHost = (stats: Stats): DurableObjects.Host => {
  const classes = new Map<string, DurableObjects.ObjectImpl>();
  const instances = new Map<string, Effect.Effect<Record<string, unknown>>>();
  const instance = (cls: string, name: string) => {
    const id = `${cls}/${name}`;
    let built = instances.get(id);
    if (built === undefined) {
      const storage = makeStorage(stats);
      const gate = Semaphore.makeUnsafe(1);
      const scope = Scope.makeUnsafe();
      const services = Effect.gen(function* () {
        let timer: { readonly at: number; readonly fiber: Fiber.Fiber<void> } | undefined;
        const callbacks = DurableObjects.alarmCallbacks(storage, {
          get: Effect.sync(() => timer?.at ?? null),
          set: (at) =>
            Effect.gen(function* () {
              const previous = timer;
              const now = yield* Clock.currentTimeMillis;
              const fiber = yield* Effect.sleep(Math.max(0, at - now)).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    timer = undefined;
                    return callbacks.fire;
                  }),
                ),
                Effect.forkIn(scope),
              );
              timer = { at, fiber };
              if (previous) yield* Fiber.interrupt(previous.fiber);
            }),
        });
        return {
          state: {
            storage,
            exclusive: (effect) => gate.withPermits(1)(effect),
            waitUntil: (effect) => Effect.asVoid(Effect.forkIn(effect, scope)),
          } satisfies DurableObjects.ObjectStateShape,
          runtime: {
            Type: "Sim",
            id,
            env: {},
            get: () => Effect.undefined,
            set: (key: string) => Effect.succeed(key),
            makeCallback: callbacks.makeCallback,
          } as RuntimeContext["Service"],
        };
      });
      built = Effect.gen(function* () {
        const { state, runtime } = yield* services;
        const record = yield* classes
          .get(cls)!
          .pipe(
            Effect.provideService(DurableObjects.ObjectState, state),
            Effect.provideService(RuntimeContext, runtime),
            Effect.provideService(Scope.Scope, scope),
          );
        // Each call runs as its own event, with the instance's runtime.
        const methods: Record<string, unknown> = {};
        for (const [method, value] of Object.entries(record)) {
          methods[method] =
            typeof value === "function"
              ? (...args: ReadonlyArray<unknown>) => {
                  const result = (value as (...args: ReadonlyArray<unknown>) => unknown)(...args);
                  return Effect.isEffect(result)
                    ? Effect.scoped(
                        (result as Effect.Effect<unknown, unknown, RuntimeContext>).pipe(
                          Effect.provideService(RuntimeContext, runtime),
                        ),
                      )
                    : result;
                }
              : value;
        }
        return methods;
      }).pipe(Effect.cached, Effect.runSync);
      instances.set(id, built);
    }
    return built;
  };
  const namespace = (cls: string): DurableObjects.Namespace => ({
    getByName: (name) =>
      new Proxy({} as DurableObjects.Stub, {
        get:
          (_, method: string) =>
          (...args: ReadonlyArray<unknown>) =>
            Effect.flatMap(instance(cls, name), (methods) => {
              const call = methods[method] as (
                ...args: ReadonlyArray<unknown>
              ) => Effect.Effect<unknown, unknown>;
              return call(...structuredClone(args)).pipe(
                Effect.map((result) => (result === undefined ? result : structuredClone(result))),
              );
            }),
      }),
  });
  return {
    declare: (model, cls, impl) =>
      Effect.sync(() => {
        const name = DurableObjects.className(model.modelName, cls);
        classes.set(name, impl);
        return namespace(name);
      }),
    lookup: (model, cls) => namespace(DurableObjects.className(model.modelName, cls)),
    claimKey: Effect.sync(() => ({})),
  };
};

// ---------------------------------------------------------------- a ledger with a view and a stream

class Booked extends Domain.Event("Booked", { n: Schema.Number }) {}
class BookMany extends Domain.Command("BookMany", {
  target: Schema.String,
  input: { count: Schema.Number },
  events: [Booked],
}) {}
class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ count: Schema.Number }),
  initial: { count: 0 },
  commands: [BookMany],
  decide: {
    BookMany: (ledger, { count }) =>
      Array.from({ length: count }, (_, i) => new Booked({ n: ledger.count + i + 1 })),
  },
  evolve: { Booked: (_, e) => ({ count: e.n }) },
}) {}

/** One view entry per booking. */
class Totals extends Domain.View("Totals", {
  from: [Ledger],
  key: Ledger,
  state: Schema.Struct({ count: Schema.Number }),
  initial: { count: 0 },
  evolve: { Booked: (_, e) => ({ count: e.n }) },
}) {}

class Line extends Domain.Event("Line", { n: Schema.Number, even: Schema.Boolean }) {}
class Lines extends Domain.Stream("Lines", { key: Ledger, entries: [Line] }) {}
class LinesWriter extends Domain.Projection("LinesWriter", {
  from: [Ledger],
  key: Ledger,
  on: [Booked],
  writes: [Lines],
}) {}
const LinesWriterLive = LinesWriter.toLayer(
  Effect.gen(function* () {
    const lines = yield* Lines;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        yield* lines.append(input, new Line({ n: input.event.n, even: input.event.n % 2 === 0 }));
      }
    });
  }),
);

class Books extends Domain.Model("Books", {
  aggregates: [Ledger],
  views: [Totals],
  projections: [LinesWriter],
  streams: [Lines],
}) {}

const ENTRIES = 200;

const onSimHost = (stats: Stats) =>
  Books.layer(LinesWriterLive).pipe(
    Layer.provideMerge(DurableObjects.makePlatform(simHost(stats))),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );

/** Book {@link ENTRIES} lines on one ledger, and wait for its view and stream to have them all. */
const booked = Effect.gen(function* () {
  const ledgers = yield* Ledger;
  const ledger = Ledger.ref("main");
  const receipt = yield* ledgers.send(ledger, new BookMany({ count: ENTRIES }));
  const atLeast = { stream: receipt.stream, version: receipt.version };
  yield* (yield* Totals).get(ledger, { atLeast });
  yield* (yield* Lines).peek(ledger, { atLeast, timeout: "30 seconds" });
  return ledger;
});

/** Rows `read` takes from storage. */
const rowsReadBy = <A, E, R>(stats: Stats, read: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = stats.rowsRead;
    const result = yield* read;
    return { result, rows: stats.rowsRead - before };
  });

describe("Domain on Durable Objects", { tags: ["unit"] }, () => {
  it.live(
    "a stream's list reads only the page it returns",
    () => {
      const stats: Stats = { rowsRead: 0 };
      return Effect.gen(function* () {
        const ledger = yield* booked;
        const lines = yield* Lines;

        const latest = yield* rowsReadBy(stats, lines.list(ledger, { order: "desc", take: 10 }));
        expect(latest.result.entries.map((entry) => entry.event.n)).toEqual(
          Array.from({ length: 10 }, (_, i) => ENTRIES - i),
        );
        expect(latest.result.cursor).toBe(ENTRIES - 9);
        // The page, one more to know there is a next page, and the key's meta.
        expect(latest.rows).toBeLessThanOrEqual(12);

        const next = yield* rowsReadBy(
          stats,
          lines.list(ledger, { order: "desc", take: 10, after: latest.result.cursor! }),
        );
        expect(next.result.entries.map((entry) => entry.event.n)).toEqual(
          Array.from({ length: 10 }, (_, i) => ENTRIES - 10 - i),
        );
        expect(next.rows).toBeLessThanOrEqual(12);

        const oldest = yield* rowsReadBy(stats, lines.list(ledger, { take: 5, after: 100 }));
        expect(oldest.result.entries.map((entry) => entry.event.n)).toEqual([
          101, 102, 103, 104, 105,
        ]);
        expect(oldest.result.cursor).toBe(105);
        expect(oldest.rows).toBeLessThanOrEqual(7);

        // The last page has no cursor.
        const last = yield* lines.list(ledger, { take: 5, after: ENTRIES - 5 });
        expect(last.entries.map((entry) => entry.event.n)).toEqual([196, 197, 198, 199, 200]);
        expect(last.cursor).toBeNull();

        // A filter reads in batches until it has a page.
        const evens = yield* rowsReadBy(
          stats,
          lines.list(ledger, { order: "desc", take: 3, where: { even: true } }),
        );
        expect(evens.result.entries.map((entry) => entry.event.n)).toEqual([200, 198, 196]);
        expect(evens.result.cursor).toBe(196);
        expect(evens.rows).toBeLessThan(ENTRIES);

        // Without `take`, every entry.
        const all = yield* lines.list(ledger);
        expect(all.entries.length).toBe(ENTRIES);
        expect(all.cursor).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(onSimHost(stats)));
    },
    { timeout: 60_000 },
  );

  it.live(
    "a view's list reads only the page it returns",
    () => {
      const stats: Stats = { rowsRead: 0 };
      return Effect.gen(function* () {
        const ledger = yield* booked;
        const totals = yield* Totals;

        const latest = yield* rowsReadBy(stats, totals.list(ledger, { order: "desc", take: 10 }));
        expect(latest.result.entries.map((entry) => entry.state?.count)).toEqual(
          Array.from({ length: 10 }, (_, i) => ENTRIES - i),
        );
        expect(latest.rows).toBeLessThanOrEqual(12);

        const oldest = yield* rowsReadBy(stats, totals.list(ledger, { take: 5, after: 100 }));
        expect(oldest.result.entries.map((entry) => entry.state?.count)).toEqual([
          101, 102, 103, 104, 105,
        ]);
        expect(oldest.rows).toBeLessThanOrEqual(7);
      }).pipe(Effect.scoped, Effect.provide(onSimHost(stats)));
    },
    { timeout: 60_000 },
  );
});
