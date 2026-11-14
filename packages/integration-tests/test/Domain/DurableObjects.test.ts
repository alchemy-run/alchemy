import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
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
const makeStorage = (stats: Stats, data: Map<string, unknown>): DurableObjects.ObjectStorage => {
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
                  data.clear();
                  for (const [key, value] of before) data.set(key, value);
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
/** What survives an object being evicted: its storage and its alarm. */
interface Disk {
  readonly objects: Map<
    string,
    { readonly data: Map<string, unknown>; alarm: number | undefined; cls: string; name: string }
  >;
}

/** Wrap a call between objects: the test decides how long it takes, or whether it fails. */
type Intercept = (
  call: { readonly cls: string; readonly method: string; readonly args: ReadonlyArray<unknown> },
  run: Effect.Effect<unknown, unknown>,
) => Effect.Effect<unknown, unknown>;

const simHost = (
  stats: Stats,
  options: { readonly disk?: Disk; readonly intercept?: Intercept } = {},
) => {
  const disk = options.disk ?? { objects: new Map() };
  const classes = new Map<string, DurableObjects.ObjectImpl>();
  const instances = new Map<string, Effect.Effect<Record<string, unknown>>>();
  const scopes = new Map<string, Scope.Closeable>();
  const instance = (cls: string, name: string) => {
    const id = `${cls}/${name}`;
    let built = instances.get(id);
    if (built === undefined) {
      const saved = disk.objects.get(id) ?? { data: new Map(), alarm: undefined, cls, name };
      disk.objects.set(id, saved);
      const storage = makeStorage(stats, saved.data);
      const gate = Semaphore.makeUnsafe(1);
      const scope = Scope.makeUnsafe();
      scopes.set(id, scope);
      const services = Effect.gen(function* () {
        let timer: { readonly at: number; readonly fiber: Fiber.Fiber<void> } | undefined;
        const set = (at: number) =>
          Effect.gen(function* () {
            const previous = timer;
            const now = yield* Clock.currentTimeMillis;
            const fiber = yield* Effect.sleep(Math.max(0, at - now)).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  timer = undefined;
                  // Like Cloudflare's, the alarm stays until its handler returns: an object
                  // evicted while it runs gets it again.
                  return callbacks.fire.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        if (saved.alarm === at) saved.alarm = undefined;
                      }),
                    ),
                  );
                }),
              ),
              Effect.forkIn(scope),
            );
            timer = { at, fiber };
            saved.alarm = at;
            if (previous) yield* Fiber.interrupt(previous.fiber);
          });
        const callbacks = DurableObjects.alarmCallbacks(storage, {
          get: Effect.sync(() => timer?.at ?? null),
          set,
        });
        // An alarm set before the object was evicted still fires.
        if (saved.alarm !== undefined) yield* set(saved.alarm);
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
          (...args: ReadonlyArray<unknown>) => {
            const run = Effect.flatMap(instance(cls, name), (methods) => {
              const call = methods[method] as (
                ...args: ReadonlyArray<unknown>
              ) => Effect.Effect<unknown, unknown>;
              return call(...structuredClone(args)).pipe(
                Effect.map((result) => (result === undefined ? result : structuredClone(result))),
              );
            });
            return options.intercept === undefined
              ? run
              : options.intercept({ cls, method, args }, run);
          },
      }),
  });
  /**
   * Evict every object: what it held in memory is gone, and its storage and
   * alarm stay. An object with an alarm runs again when the alarm is due.
   */
  const wake = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const saved of disk.objects.values()) {
      if (saved.alarm === undefined) continue;
      const { cls, name } = saved;
      yield* Effect.sleep(Math.max(0, saved.alarm - now)).pipe(
        Effect.andThen(Effect.suspend(() => instance(cls, name))),
        Effect.forkDetach,
      );
    }
  });
  const evict = Effect.gen(function* () {
    for (const scope of scopes.values()) yield* Scope.close(scope, Exit.void);
    scopes.clear();
    instances.clear();
    yield* wake;
  });
  const host: DurableObjects.Host = {
    declare: (model, cls, impl) =>
      Effect.sync(() => {
        const name = DurableObjects.className(model.modelName, cls);
        classes.set(name, impl);
        return namespace(name);
      }),
    lookup: (model, cls) => namespace(DurableObjects.className(model.modelName, cls)),
    claimKey: Effect.sync(() => ({})),
  };
  return { host, evict, wake, disk };
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
    Layer.provideMerge(DurableObjects.makePlatform(simHost(stats).host)),
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

// ---------------------------------------------------------------- listing in the directory

/** The class that holds the directory of instances. */
const isDirectory = (cls: string) => cls.endsWith("DomainDirectory");

/**
 * Watch the directory: which instances it was asked to list, once a listing has
 * landed. `hold` makes a listing wait, `fail` makes it fail, until the test says so.
 */
const watchDirectory = () => {
  const listed: Array<string> = [];
  const state = {
    attempts: 0,
    failing: false,
    gate: undefined as Deferred.Deferred<void> | undefined,
  };
  const intercept: Intercept = ({ cls, method, args }, run) =>
    !isDirectory(cls) || method !== "register"
      ? run
      : Effect.gen(function* () {
          state.attempts += 1;
          if (state.gate) yield* Deferred.await(state.gate);
          if (state.failing) return yield* Effect.die(new Error("the directory is not there"));
          const result = yield* run;
          listed.push((args[1] as { readonly id: string }).id);
          return result;
        });
  return { listed, state, intercept };
};

/** Wait until `until` holds, as the objects' alarms run in the background. */
const eventually = (until: () => boolean, within: Duration.Input = "15 seconds") =>
  Effect.gen(function* () {
    while (!until()) yield* Effect.sleep("20 millis");
  }).pipe(Effect.timeout(within));

/** A ledger that has a view and nothing else: the model before a projection is deployed. */
class BooksBefore extends Domain.Model("Books", {
  aggregates: [Ledger],
  views: [Totals],
}) {}

const sendOne = Effect.gen(function* () {
  const ledger = Ledger.ref("main");
  const receipt = yield* (yield* Ledger).send(ledger, new BookMany({ count: 1 }));
  return { ledger, receipt };
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
  it.live(
    "a new instance's first commit does not wait for the directory, which lists it afterwards",
    () => {
      const stats: Stats = { rowsRead: 0 };
      const directory = watchDirectory();
      directory.state.gate = Deferred.makeUnsafe<void>();
      return Effect.gen(function* () {
        // The directory is stuck: the command still commits and answers.
        const { receipt } = yield* sendOne.pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.die(new Error("the first command waited for the directory")),
          }),
        );
        expect(receipt.version).toBe(1);
        // The instance's own state is saved: a second command sees it.
        const second = yield* (yield* Ledger).send(Ledger.ref("main"), new BookMany({ count: 1 }));
        expect(second.version).toBe(2);
        expect(directory.listed).toEqual([]);
        // It is listed once the directory answers, with no further command.
        yield* eventually(() => directory.state.attempts > 0);
        yield* Deferred.succeed(directory.state.gate!, undefined);
        yield* eventually(() => directory.listed.length > 0);
        expect(directory.listed).toContain("main");
        // It is listed once: nothing is pending afterwards.
        const attempts = directory.state.attempts;
        yield* (yield* Ledger).send(Ledger.ref("main"), new BookMany({ count: 1 }));
        yield* Effect.sleep("300 millis");
        expect(directory.state.attempts).toBe(attempts);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          BooksBefore.layer(Layer.empty).pipe(
            Layer.provideMerge(
              DurableObjects.makePlatform(simHost(stats, { intercept: directory.intercept }).host),
            ),
            Layer.provideMerge(SecureRandom.layerWebCrypto),
          ),
        ),
      );
    },
    { timeout: 60_000 },
  );

  it.live(
    "a listing that fails is retried, and survives the instance being evicted",
    () => {
      const stats: Stats = { rowsRead: 0 };
      const directory = watchDirectory();
      directory.state.failing = true;
      const sim = simHost(stats, { intercept: directory.intercept });
      return Effect.gen(function* () {
        yield* sendOne;
        yield* eventually(() => directory.state.attempts > 0);
        // The listing is in flight and failing: lose everything in memory.
        yield* Effect.sleep("200 millis");
        expect(directory.listed).toEqual([]);
        yield* sim.evict;
        directory.state.failing = false;
        // Nothing calls the instance again: its stored alarm runs the listing.
        yield* eventually(() => directory.listed.includes("main"));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          BooksBefore.layer(Layer.empty).pipe(
            Layer.provideMerge(DurableObjects.makePlatform(sim.host)),
            Layer.provideMerge(SecureRandom.layerWebCrypto),
          ),
        ),
      );
    },
    { timeout: 60_000 },
  );

  it.live(
    "a projection deployed after a commit, before the instance is listed, gets that commit's history",
    () => {
      const stats: Stats = { rowsRead: 0 };
      const disk: Disk = { objects: new Map() };
      const before = watchDirectory();
      before.state.failing = true;
      const after = watchDirectory();
      after.state.gate = Deferred.makeUnsafe<void>();
      const first = simHost(stats, { disk, intercept: before.intercept });
      const second = simHost(stats, { disk, intercept: after.intercept });
      const sentBefore = BooksBefore.layer(Layer.empty).pipe(
        Layer.provideMerge(DurableObjects.makePlatform(first.host)),
        Layer.provideMerge(SecureRandom.layerWebCrypto),
      );
      return Effect.gen(function* () {
        // The old code commits, and cannot list the instance.
        yield* sendOne.pipe(Effect.provide(sentBefore));
        yield* eventually(() => before.state.attempts > 0);
        yield* Effect.sleep("200 millis");
        expect(before.listed).toEqual([]);
        // The projection is deployed: its run lists a directory the instance isn't in.
        yield* Effect.gen(function* () {
          yield* second.wake;
          const lines = yield* Lines;
          yield* eventually(() => after.state.attempts > 0);
          yield* Effect.sleep("1500 millis");
          expect(after.listed).toEqual([]);
          // Now the instance lists itself, and the projection still gets its history.
          yield* Deferred.succeed(after.state.gate!, undefined);
          const entries = yield* lines.peek(Ledger.ref("main"), {
            atLeast: { stream: "Ledger/main", version: 1 },
            timeout: "30 seconds",
          });
          expect(entries).toBeDefined();
        }).pipe(
          Effect.provide(
            Books.layer(LinesWriterLive).pipe(
              Layer.provideMerge(DurableObjects.makePlatform(second.host)),
              Layer.provideMerge(SecureRandom.layerWebCrypto),
            ),
          ),
        );
      }).pipe(Effect.scoped);
    },
    { timeout: 90_000 },
  );
});
