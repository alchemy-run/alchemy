import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { type InputGateShape, makeInputGate } from "alchemy/Workers/InputGate";
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

/**
 * Objects run in this process: one instance per name, built on its first
 * call, with storage that counts rows read and one alarm for its callbacks.
 * Calls cross a JSON boundary, as Workers RPC does.
 */
/**
 * Storage behind an instance's input gate, as Rivet's bridge runs it: each
 * operation waits for its call's turn, and a transaction holds the gate.
 */
const gatedStorage = (
  storage: DurableObjects.ObjectStorage,
  gate: InputGateShape,
): DurableObjects.ObjectStorage => ({
  get: (key) => gate.storage(storage.get(key)),
  put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
    gate.storage(
      typeof keyOrEntries === "string"
        ? storage.put(keyOrEntries, value)
        : storage.put(keyOrEntries),
    )) as DurableObjects.ObjectStorage["put"],
  delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
    typeof keyOrKeys === "string"
      ? gate.storage(storage.delete(keyOrKeys))
      : gate.storage(storage.delete(keyOrKeys))) as DurableObjects.ObjectStorage["delete"],
  list: (options) => gate.storage(storage.list(options)),
  transaction: (effect) => gate.exclusive(storage.transaction(effect)),
});

const simHost = (
  stats: Stats,
  options: {
    readonly disk?: Disk;
    readonly intercept?: Intercept;
    /** Give each instance Rivet's input gate: construction and each call are calls of their own. */
    readonly inputGate?: boolean;
  } = {},
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
      const inputGate = options.inputGate ? Effect.runSync(makeInputGate) : undefined;
      const asCall = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        inputGate === undefined ? effect : inputGate.call(effect);
      const stored = makeStorage(stats, saved.data);
      const storage = inputGate === undefined ? stored : gatedStorage(stored, inputGate);
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
            asCall,
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
                          asCall,
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

// ---------------------------------------------------------------- a projection fed by a view

class Milestone extends Domain.Event("Milestone", { n: Schema.Number }) {}

/** Emits only every tenth booking: most commands become nothing here. */
class Milestones extends Domain.View("Milestones", {
  from: [Ledger],
  key: Ledger,
  events: [Milestone],
  emit: { Booked: (e) => (e.n % 10 === 0 ? new Milestone({ n: e.n }) : undefined) },
}) {}

class MilestoneLog extends Domain.Stream("MilestoneLog", { key: Ledger, entries: [Milestone] }) {}
class MilestoneWriter extends Domain.Projection("MilestoneWriter", {
  from: [Milestones],
  key: Ledger,
  on: [Milestone],
  writes: [MilestoneLog],
}) {}
const MilestoneWriterLive = MilestoneWriter.toLayer(
  Effect.gen(function* () {
    const log = yield* MilestoneLog;
    return Effect.fn(function* (batch) {
      for (const input of batch) yield* log.append(input, input.event);
    });
  }),
);

class Milestoned extends Domain.Model("Milestoned", {
  aggregates: [Ledger],
  views: [Milestones],
  projections: [MilestoneWriter],
  streams: [MilestoneLog],
}) {}

const milestonesOnSimHost = (stats: Stats, disk: Disk) =>
  Milestoned.layer(MilestoneWriterLive).pipe(
    Layer.provideMerge(DurableObjects.makePlatform(simHost(stats, { disk }).host)),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );

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
  it.live(
    "caughtUp through a view reads the command's entries, not the view's history",
    () => {
      const stats: Stats = { rowsRead: 0 };
      const disk: Disk = { objects: new Map() };
      return Effect.gen(function* () {
        const ledgers = yield* Ledger;
        const log = yield* MilestoneLog;
        const ledger = Ledger.ref("main");
        const book = (count: number) => ledgers.send(ledger, new BookMany({ count }));
        const logged = Effect.map(log.list(ledger), (page) => page.entries.map((e) => e.event.n));
        const milestones = yield* Milestones;
        /** Wait for the view to apply a command. */
        const applied = (receipt: { readonly stream: string; readonly version: number }) =>
          milestones.get(ledger, {
            atLeast: { stream: receipt.stream, version: receipt.version },
          });
        /** Drop each view key's record of what commands became, as snapshots before it had. */
        const stripRecords = Effect.sync(() => {
          for (const { data } of disk.objects.values()) {
            const snapshot = data.get("snapshot") as { emitted?: unknown } | undefined;
            if (snapshot?.emitted === undefined) continue;
            const { emitted: _, ...older } = snapshot;
            data.set("snapshot", older);
          }
        });
        // A hundred milestones in the view's history.
        for (let i = 0; i < 100; i++) yield* MilestoneWriter.caughtUp(yield* book(10));
        expect((yield* logged).length).toBe(100);

        // Three bookings and no milestone. Once the view has applied them, its
        // key's snapshot says they emitted nothing: no entry is read.
        const quiet = yield* book(3);
        yield* applied(quiet);
        const recorded = yield* rowsReadBy(stats, MilestoneWriter.caughtUp(quiet));
        expect(recorded.rows).toBeLessThan(5);
        // Without the record, as written before it existed, the view's history is searched.
        yield* stripRecords;
        const searched = yield* rowsReadBy(stats, MilestoneWriter.caughtUp(quiet));
        expect(searched.rows).toBeGreaterThanOrEqual(100);

        // A later command reached the view first: found by the command's id.
        const earlier = yield* book(7);
        const later = yield* book(10);
        yield* applied(later);
        yield* MilestoneWriter.caughtUp(earlier);
        expect(yield* logged).toContain(1010);
        yield* MilestoneWriter.caughtUp(later);
        expect((yield* logged).slice(-2)).toEqual([1010, 1020]);

        // A snapshot written before the record existed: found by the command's id.
        const legacy = yield* book(10);
        yield* applied(legacy);
        yield* stripRecords;
        yield* MilestoneWriter.caughtUp(legacy);
        expect((yield* logged).at(-1)).toBe(1030);
      }).pipe(Effect.scoped, Effect.provide(milestonesOnSimHost(stats, disk)));
    },
    { timeout: 60_000 },
  );

  it.live(
    "a command commits on a host with an input gate, as Rivet runs one",
    () => {
      const stats: Stats = { rowsRead: 0 };
      const gated = Books.layer(LinesWriterLive).pipe(
        Layer.provideMerge(DurableObjects.makePlatform(simHost(stats, { inputGate: true }).host)),
        Layer.provideMerge(SecureRandom.layerWebCrypto),
      );
      return Effect.gen(function* () {
        const ledgers = yield* Ledger;
        // A first commit schedules its listing in the directory inside its
        // transaction: that work must count as the commit's own call, or it
        // waits on the gate the transaction holds.
        const receipt = yield* ledgers
          .send(Ledger.ref("gated"), new BookMany({ count: 1 }))
          .pipe(Effect.timeout("5 seconds"));
        expect(receipt.version).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(gated));
    },
    { timeout: 30_000 },
  );
});

// ---------------------------------------------------------------- aggregate versions

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Withdrawn],
}) {}
const Balance = Schema.Struct({ balance: Schema.Number });
const decideAccount = {
  Deposit: (_: unknown, cmd: Deposit) => [new Deposited({ amount: cmd.amount })],
  Withdraw: (_: unknown, cmd: Withdraw) => [new Withdrawn({ amount: cmd.amount })],
};
/** Version 0, with a fault: withdrawals are not subtracted. */
class AccountV0 extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Balance,
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  decide: decideAccount,
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }), Withdrawn: (s) => s },
}) {}
/** The fault fixed, at version 1. */
class AccountV1 extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Balance,
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  decide: decideAccount,
  evolve: {
    Deposited: (s, e) => ({ balance: s.balance + e.amount }),
    Withdrawn: (s, e) => ({ balance: s.balance - e.amount }),
  },
  version: 1,
}) {}
const Net = Schema.Struct({ net: Schema.Number });
/** One row per account, counting deposits only: the same view on either account. */
class SummaryOfV0 extends Domain.View("Summary", {
  from: [AccountV0],
  key: AccountV0,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (s, e) => ({ net: s.net + e.amount }) },
}) {}
class SummaryOfV1 extends Domain.View("Summary", {
  from: [AccountV1],
  key: AccountV1,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (s, e) => ({ net: s.net + e.amount }) },
}) {}
class BankV0 extends Domain.Model("Bank", { aggregates: [AccountV0], views: [SummaryOfV0] }) {}
class BankV1 extends Domain.Model("Bank", { aggregates: [AccountV1], views: [SummaryOfV1] }) {}

/** The ledger summing its bookings rather than counting them, at version 1. */
class LedgerSummed extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ count: Schema.Number }),
  initial: { count: 0 },
  commands: [BookMany],
  decide: {
    BookMany: (ledger, { count }) =>
      Array.from({ length: count }, (_, i) => new Booked({ n: ledger.count + i + 1 })),
  },
  evolve: { Booked: (s, e) => ({ count: s.count + e.n }) },
  version: 1,
}) {}
class LedgersV0 extends Domain.Model("Ledgers", { aggregates: [Ledger] }) {}
class LedgersV1 extends Domain.Model("Ledgers", { aggregates: [LedgerSummed] }) {}

/** Host `model` on a new sim host over `disk`, as a deploy of new code over old storage does. */
const deployedOn = (
  stats: Stats,
  disk: Disk,
  model: { readonly layer: (policies: any) => Layer.Layer<any, any, any> },
) =>
  model
    .layer(Layer.empty)
    .pipe(
      Layer.provideMerge(DurableObjects.makePlatform(simHost(stats, { disk }).host)),
      Layer.provideMerge(SecureRandom.layerWebCrypto),
    );

/** The stored rows of one aggregate instance on `disk`. */
const instanceRows = (disk: Disk, aggregate: string, id: string) => {
  const found = [...disk.objects.values()].find(
    (saved) => saved.name === id && saved.cls.endsWith(`${aggregate}Aggregate`),
  );
  const data = found?.data ?? new Map<string, unknown>();
  return {
    events: [...data.keys()].filter((key) => key.startsWith("event:")).length,
    meta: data.get("meta") as { readonly version: number; readonly generation?: number },
  };
};

describe("Domain aggregate versions on Durable Objects", { tags: ["unit"] }, () => {
  it.live(
    "bumping an aggregate's version folds each instance again in place, and records nothing",
    () => {
      const stats: Stats = { rowsRead: 0 };
      const disk: Disk = { objects: new Map() };
      const balance = Effect.gen(function* () {
        return yield* (yield* AccountV0).get(AccountV0.ref("a-1"));
      });
      return Effect.gen(function* () {
        const summaryBefore = yield* Effect.gen(function* () {
          const accounts = yield* AccountV0;
          // The summary reads deposits only: wait for the deposit.
          const receipt = yield* accounts.send(AccountV0.ref("a-1"), new Deposit({ amount: 10 }));
          yield* accounts.send(AccountV0.ref("a-1"), new Withdraw({ amount: 4 }));
          expect(yield* balance).toEqual({ balance: 10 });
          return yield* (yield* SummaryOfV0).get(AccountV0.ref("a-1"), {
            atLeast: { stream: receipt.stream, version: receipt.version },
          });
        }).pipe(Effect.scoped, Effect.provide(deployedOn(stats, disk, BankV0)));
        const before = instanceRows(disk, "Account", "a-1");
        expect(before).toEqual({ events: 2, meta: { version: 2, state: { balance: 10 } } });

        yield* Effect.gen(function* () {
          // Read before any command: folded again from its two events.
          expect(yield* balance).toEqual({ balance: 6 });
          const after = instanceRows(disk, "Account", "a-1");
          expect(after.events).toBe(2);
          expect(after.meta).toEqual({ version: 2, generation: 1, state: { balance: 6 } });
          expect(yield* (yield* SummaryOfV1).get(AccountV1.ref("a-1"))).toEqual(summaryBefore);
          // A command decides on the folded state, as the stream's third event.
          const receipt = yield* (yield* AccountV1).send(
            AccountV1.ref("a-1"),
            new Deposit({ amount: 1 }),
          );
          expect(receipt.version).toBe(3);
          expect(yield* balance).toEqual({ balance: 7 });
        }).pipe(Effect.scoped, Effect.provide(deployedOn(stats, disk, BankV1)));
      });
    },
    { timeout: 60_000 },
  );

  it.live(
    "a stream longer than a page is folded again in order, once",
    () => {
      const stats: Stats = { rowsRead: 0 };
      const disk: Disk = { objects: new Map() };
      // 300 events: more than two pages of the fold.
      const BOOKED = 300;
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* (yield* Ledger).send(Ledger.ref("main"), new BookMany({ count: BOOKED }));
        }).pipe(Effect.scoped, Effect.provide(deployedOn(stats, disk, LedgersV0)));
        expect(instanceRows(disk, "Ledger", "main").meta).toEqual({
          version: BOOKED,
          state: { count: BOOKED },
        });

        yield* Effect.gen(function* () {
          const ledgers = yield* LedgerSummed;
          const first = yield* rowsReadBy(stats, ledgers.get(LedgerSummed.ref("main")));
          // 1 + 2 + ... + 300, in order across the pages.
          expect(first.result).toEqual({ count: (BOOKED * (BOOKED + 1)) / 2 });
          expect(first.rows).toBeGreaterThanOrEqual(BOOKED);
          // Once: the next read finds it folded, and reads no event.
          const second = yield* rowsReadBy(stats, ledgers.get(LedgerSummed.ref("main")));
          expect(second.result).toEqual(first.result);
          expect(second.rows).toBeLessThan(5);
          // A ledger first opened after the bump is never folded.
          yield* ledgers.send(LedgerSummed.ref("new"), new BookMany({ count: 3 }));
          const opened = yield* rowsReadBy(stats, ledgers.get(LedgerSummed.ref("new")));
          expect(opened.result).toEqual({ count: 6 });
          expect(opened.rows).toBeLessThan(5);
        }).pipe(Effect.scoped, Effect.provide(deployedOn(stats, disk, LedgersV1)));
      });
    },
    { timeout: 60_000 },
  );
});
