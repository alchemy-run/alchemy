import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import { InMemory } from "@alchemy.run/domain/InMemory";
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import { type Disk, type Intercept, simHost, type Stats } from "./sim-host.ts";

// ---------------------------------------------------------------- a ledger with a view and a stream

class Booked extends Domain.Event("Booked", { n: Schema.Number }) {}
class BookMany extends Domain.Command("BookMany", {
  input: { id: Schema.String, count: Schema.Number },
  events: [Booked],
}) {}
class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ count: Schema.Number }),
  initial: { count: 0 },
  commands: [BookMany],
  keyOf: (command) => command.id,
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

const booksOn = (disk: Disk) =>
  Books.layer(LinesWriterLive).pipe(
    Layer.provideMerge(DurableObjects.makePlatform(simHost({ rowsRead: 0 }, { disk }).host)),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );

const onSimHost = (stats: Stats) =>
  Books.layer(LinesWriterLive).pipe(
    Layer.provideMerge(DurableObjects.makePlatform(simHost(stats).host)),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );

/** Book {@link ENTRIES} lines on one ledger, and wait for its view and stream to have them all. */
const booked = Effect.gen(function* () {
  const ledgers = yield* Ledger;
  const ledger = Ledger.ref("main");
  const receipt = yield* ledgers.send(new BookMany({ id: ledger.id, count: ENTRIES }));
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
    /** Attempts by the source that asked: a view's keys list themselves too, in their own time. */
    attemptsBy: {} as Record<string, number>,
    failing: false,
    gate: undefined as Deferred.Deferred<void> | undefined,
  };
  const intercept: Intercept = ({ cls, method, args }, run) =>
    !isDirectory(cls) || method !== "register"
      ? run
      : Effect.gen(function* () {
          state.attempts += 1;
          const { source } = args[1] as { readonly source: string };
          state.attemptsBy[source] = (state.attemptsBy[source] ?? 0) + 1;
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
  const receipt = yield* (yield* Ledger).send(new BookMany({ id: ledger.id, count: 1 }));
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

// ---------------------------------------------------------------- importing a ledger's history

class Noted extends Domain.Event("Noted", { n: Schema.Number }) {}
class Note extends Domain.Command("Note", {
  input: { id: Schema.String, n: Schema.Number },
  events: [Noted],
}) {}
/** What the policy saw: every booking it reacted to. */
class Audit extends Domain.Aggregate("Audit", {
  id: Schema.String,
  state: Schema.Struct({ seen: Schema.Array(Schema.Number) }),
  initial: { seen: [] },
  commands: [Note],
  keyOf: (command) => command.id,
  decide: { Note: (_, { n }) => [new Noted({ n })] },
  evolve: { Noted: (audit, e) => ({ seen: [...audit.seen, e.n] }) },
}) {}
class AuditBookings extends Domain.Policy("AuditBookings", { from: Ledger, on: [Booked] }) {}
const AuditBookingsLive = AuditBookings.toLayer(
  Effect.gen(function* () {
    const audits = yield* Audit;
    return Effect.fn(function* ({ source, event }) {
      yield* audits.send(new Note({ id: source.id, n: event.n }));
    });
  }),
);

class Imports extends Domain.Model("Imports", {
  aggregates: [Ledger, Audit],
  views: [Totals],
  policies: [AuditBookings],
  projections: [LinesWriter],
  streams: [Lines],
}) {}

const importsOn = (platform: Layer.Layer<Domain.Platform, never, SecureRandom.SecureRandom>) =>
  Imports.layer(Layer.mergeAll(LinesWriterLive, AuditBookingsLive)).pipe(
    Layer.provideMerge(platform),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );

// ---------------------------------------------------------------- retention

/** A ledger whose bookings a policy notes: receipts, cancelled names and delivery marks. */
class Retained extends Domain.Model("Retained", {
  aggregates: [Ledger, Audit],
  policies: [AuditBookings],
}) {}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

/**
 * Run `effect` at the time `now` holds, set by the test. Sleeps stay real:
 * the objects' alarms and deliveries wait on them.
 */
const atTime =
  (now: { millis: number }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const live = yield* Clock.Clock;
      const clock: Clock.Clock = {
        ...live,
        currentTimeMillisUnsafe: () => now.millis,
        currentTimeMillis: Effect.sync(() => now.millis),
        currentTimeNanosUnsafe: () => BigInt(now.millis) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(now.millis) * 1_000_000n),
        sleep: (duration) => live.sleep(duration),
      };
      return yield* effect.pipe(Effect.provideService(Clock.Clock, clock));
    });

const retainedOn = (disk: Disk, retention?: DurableObjects.Retention) =>
  Retained.layer(AuditBookingsLive).pipe(
    Layer.provideMerge(
      DurableObjects.makePlatform(
        simHost({ rowsRead: 0 }, { disk }).host,
        retention === undefined ? {} : { retention },
      ),
    ),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );

/** The keys of every object whose id ends with `suffix` that start with one of `prefixes`. */
const keysIn = (disk: Disk, suffix: string, prefixes: ReadonlyArray<string>) =>
  [...disk.objects.entries()]
    .filter(([id]) => id.endsWith(suffix))
    .flatMap(([, saved]) => [...saved.data.keys()])
    .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
    .sort();

/** The ledger's receipts and scheduled names. */
const ledgerRows = (disk: Disk) => keysIn(disk, "LedgerAggregate/main", ["receipt:", "scheduled:"]);
/** The policy's delivery marks. */
const marks = (disk: Disk) => keysIn(disk, "", ["seen:"]);

/** Book one line on the ledger under `commandId`, and wait for the policy to note it. */
const bookAs = (commandId: string) =>
  Effect.gen(function* () {
    const receipt = yield* (yield* Ledger).send(new BookMany({ id: "main", count: 1 }), {
      commandId,
    });
    const audits = yield* Audit;
    yield* Effect.gen(function* () {
      while (!(yield* audits.get("main")).seen.includes(receipt.version))
        yield* Effect.sleep("20 millis");
    }).pipe(Effect.timeout("15 seconds"));
    return receipt;
  });

/** Arm the command `name` on the ledger, an hour out, and cancel it. */
const cancelled = (name: string) =>
  Effect.gen(function* () {
    const ledgers = yield* Ledger;
    yield* ledgers.schedule(new BookMany({ id: "main", count: 1 }), {
      after: "1 hour",
      commandId: name,
    });
    yield* ledgers.unschedule("main", name);
  });

/** What cancelling `name` again answers. */
const cancelledAgain = (name: string) =>
  Effect.gen(function* () {
    const ledgers = yield* Ledger;
    return yield* Effect.flip(ledgers.unschedule("main", name));
  });

describe("Domain on Durable Objects", { tags: ["unit"] }, () => {
  for (const [name, platform] of [
    ["Durable Objects", () => DurableObjects.makePlatform(simHost({ rowsRead: 0 }).host)],
    ["the in-memory platform", () => InMemory],
  ] as const) {
    it.live(
      `an import appends history once, to views and projections only, on ${name}`,
      () =>
        Effect.gen(function* () {
          const ledgers = yield* Ledger;
          const ledger = Ledger.ref("imported");
          const booked = (from: number, to: number) =>
            Array.from({ length: to - from + 1 }, (_, i) => new Booked({ n: from + i }));

          const first = yield* ledgers.import(ledger, booked(1, 3), { commandId: "import:1" });
          expect(first.stream).toBe("Ledger/imported");
          expect(first.version).toBe(3);
          expect(first.events.map((event) => event.n)).toEqual([1, 2, 3]);
          expect(yield* ledgers.get(ledger)).toEqual({ count: 3 });

          // A retry commits nothing and answers the first receipt.
          expect(yield* ledgers.import(ledger, booked(1, 3), { commandId: "import:1" })).toEqual(
            first,
          );
          // Another import expects an instance with no events.
          const refused = yield* ledgers
            .import(ledger, booked(1, 3), { commandId: "import:again" })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({
            _tag: "UnexpectedVersion",
            aggregate: "Ledger",
            id: "imported",
            expected: 0,
            version: 3,
          });

          // The next batch continues from the previous receipt, more than a storage put takes.
          const second = yield* ledgers.import(ledger, booked(4, 203), {
            commandId: "import:2",
            expectedVersion: first.version,
          });
          expect(second.version).toBe(203);

          const atLeast = { stream: second.stream, version: second.version };
          expect(yield* (yield* Totals).get(ledger, { atLeast })).toEqual(
            Option.some({ count: 203 }),
          );
          yield* LinesWriter.caughtUp(second, { timeout: "30 seconds" });
          const { entries } = yield* (yield* Lines).list(ledger);
          expect(entries.map((entry) => entry.event.n)).toEqual(booked(1, 203).map((e) => e.n));

          // A command after the import is decided from the imported state, and
          // the policy reacts to its event alone.
          const sent = yield* ledgers.send(new BookMany({ id: "imported", count: 1 }));
          expect(sent.version).toBe(204);
          const audits = yield* Audit;
          yield* Effect.gen(function* () {
            while ((yield* audits.get("imported")).seen.length === 0)
              yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("15 seconds"));
          expect(yield* audits.get("imported")).toEqual({ seen: [204] });
        }).pipe(Effect.scoped, Effect.provide(importsOn(platform()))),
      { timeout: 60_000 },
    );
  }

  for (const [name, platform] of [
    ["Durable Objects", () => DurableObjects.makePlatform(simHost({ rowsRead: 0 }).host)],
    ["the in-memory platform", () => InMemory],
  ] as const) {
    it.live(
      `a view's snapshot says which fact it reflects, on ${name}`,
      () =>
        Effect.gen(function* () {
          const ledger = Ledger.ref("positioned");
          const totals = yield* Totals;
          expect((yield* totals.snapshot(ledger)).position).toBeUndefined();
          yield* (yield* Ledger).send(new BookMany({ id: ledger.id, count: 2 }));
          const receipt = yield* (yield* Ledger).send(new BookMany({ id: ledger.id, count: 1 }));
          const atLeast = { stream: receipt.stream, version: receipt.version };
          expect(yield* totals.snapshot(ledger, { atLeast })).toEqual({
            state: { count: 3 },
            cursor: 3,
            position: { stream: "Ledger/positioned", seq: 3 },
          });
        }).pipe(
          Effect.scoped,
          Effect.provide(
            BooksBefore.layer(Layer.empty).pipe(
              Layer.provideMerge(platform()),
              Layer.provideMerge(SecureRandom.layerWebCrypto),
            ),
          ),
        ),
      { timeout: 60_000 },
    );
  }

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
        const second = yield* (yield* Ledger).send(
          new BookMany({ id: Ledger.ref("main").id, count: 1 }),
        );
        expect(second.version).toBe(2);
        expect(directory.listed).toEqual([]);
        // It is listed once the directory answers, with no further command.
        yield* eventually(() => directory.state.attempts > 0);
        yield* Deferred.succeed(directory.state.gate!, undefined);
        yield* eventually(() => directory.listed.length > 0);
        expect(directory.listed).toContain("main");
        // It is listed once: nothing is pending afterwards.
        const attempts = directory.state.attemptsBy.Ledger;
        yield* (yield* Ledger).send(new BookMany({ id: Ledger.ref("main").id, count: 1 }));
        yield* Effect.sleep("300 millis");
        expect(directory.state.attemptsBy.Ledger).toBe(attempts);
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
        const book = (count: number) => ledgers.send(new BookMany({ id: ledger.id, count }));
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
    "each kind of dedupe row is deleted once it is older than its window",
    () => {
      const disk: Disk = { objects: new Map() };
      const now = { millis: T0 };
      return Effect.gen(function* () {
        yield* bookAs("c-1");
        yield* cancelled("later");
        expect(ledgerRows(disk)).toEqual(["receipt:c-1", "scheduled:later"]);
        expect(marks(disk)).toHaveLength(1);

        // A week on: nothing has outlived its window yet.
        now.millis = T0 + 7 * DAY;
        yield* bookAs("c-2");
        expect(ledgerRows(disk)).toEqual(["receipt:c-1", "receipt:c-2", "scheduled:later"]);
        expect(marks(disk)).toHaveLength(2);
        expect(yield* cancelledAgain("later")).toMatchObject({ _tag: "AlreadyCancelled" });

        // A moment later: the cancelled command and the first delivery mark go.
        now.millis = T0 + 7 * DAY + 1;
        yield* bookAs("c-3");
        expect(ledgerRows(disk)).toEqual(["receipt:c-1", "receipt:c-2", "receipt:c-3"]);
        expect(marks(disk)).toHaveLength(2);
        expect(yield* cancelledAgain("later")).toMatchObject({ _tag: "NotScheduled" });

        // Thirty days on: the first receipt goes, and its command sent again is decided again.
        now.millis = T0 + 30 * DAY + 1;
        expect((yield* bookAs("c-4")).version).toBe(4);
        expect(ledgerRows(disk)).toEqual(["receipt:c-2", "receipt:c-3", "receipt:c-4"]);
        expect((yield* bookAs("c-1")).version).toBe(5);
        // Every index row left stands for a row that is still there.
        expect(keysIn(disk, "LedgerAggregate/main", ["aged:", "aged-at:"])).toHaveLength(4);
      }).pipe(Effect.scoped, Effect.provide(retainedOn(disk)), atTime(now));
    },
    { timeout: 60_000 },
  );

  it.live(
    "a name cancelled again starts its window again",
    () => {
      const disk: Disk = { objects: new Map() };
      const now = { millis: T0 };
      return Effect.gen(function* () {
        yield* cancelled("expire");
        // Armed and cancelled again six days later: its week starts then.
        now.millis = T0 + 6 * DAY;
        yield* cancelled("expire");
        now.millis = T0 + 8 * DAY;
        yield* bookAs("c-1");
        expect(ledgerRows(disk)).toContain("scheduled:expire");
        expect(yield* cancelledAgain("expire")).toMatchObject({ _tag: "AlreadyCancelled" });
        now.millis = T0 + 13 * DAY + 1;
        yield* bookAs("c-2");
        expect(ledgerRows(disk)).not.toContain("scheduled:expire");
      }).pipe(Effect.scoped, Effect.provide(retainedOn(disk)), atTime(now));
    },
    { timeout: 60_000 },
  );

  it.live(
    "rows kept from before an upgrade age from the first commit after it",
    () => {
      const disk: Disk = { objects: new Map() };
      const now = { millis: T0 };
      return Effect.gen(function* () {
        yield* bookAs("c-1");
        yield* cancelled("later");
        // As 2.0.0-beta.87 and earlier left them: no index rows.
        for (const saved of disk.objects.values())
          for (const key of [...saved.data.keys()])
            if (key.startsWith("aged")) saved.data.delete(key);

        now.millis = T0 + 100 * DAY;
        yield* bookAs("c-2");
        expect(ledgerRows(disk)).toEqual(["receipt:c-1", "receipt:c-2", "scheduled:later"]);
        expect(marks(disk)).toHaveLength(2);

        // A week after the upgrade: the old cancelled name and both marks from then go.
        now.millis = T0 + 107 * DAY + 1;
        yield* bookAs("c-3");
        expect(ledgerRows(disk)).toEqual(["receipt:c-1", "receipt:c-2", "receipt:c-3"]);
        expect(marks(disk)).toEqual(["seen:Ledger/main:3"]);

        now.millis = T0 + 130 * DAY + 1;
        yield* bookAs("c-4");
        expect(ledgerRows(disk)).toEqual(["receipt:c-3", "receipt:c-4"]);
      }).pipe(Effect.scoped, Effect.provide(retainedOn(disk)), atTime(now));
    },
    { timeout: 60_000 },
  );

  it.live(
    "a window of forever keeps that kind of row",
    () => {
      const disk: Disk = { objects: new Map() };
      const now = { millis: T0 };
      return Effect.gen(function* () {
        yield* bookAs("c-1");
        yield* cancelled("later");
        now.millis = T0 + 365 * DAY;
        yield* bookAs("c-2");
        expect(ledgerRows(disk)).toEqual(["receipt:c-1", "receipt:c-2", "scheduled:later"]);
        expect(marks(disk)).toHaveLength(2);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          retainedOn(disk, { receipts: "forever", deliveries: "forever", cancelled: "forever" }),
        ),
        atTime(now),
      );
    },
    { timeout: 60_000 },
  );

  it.live(
    "a commit deletes only a few expired rows",
    () => {
      const disk: Disk = { objects: new Map() };
      const now = { millis: T0 };
      return Effect.gen(function* () {
        const ledgers = yield* Ledger;
        for (let i = 0; i < 40; i++)
          yield* ledgers.send(new BookMany({ id: "main", count: 1 }), { commandId: `old-${i}` });
        now.millis = T0 + 31 * DAY;
        const receipts = () => keysIn(disk, "LedgerAggregate/main", ["receipt:"]).length;
        yield* ledgers.send(new BookMany({ id: "main", count: 1 }), { commandId: "late-1" });
        expect(receipts()).toBe(25);
        yield* ledgers.send(new BookMany({ id: "main", count: 1 }), { commandId: "late-2" });
        expect(receipts()).toBe(10);
        yield* ledgers.send(new BookMany({ id: "main", count: 1 }), { commandId: "late-3" });
        expect(receipts()).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(retainedOn(disk)), atTime(now));
    },
    { timeout: 60_000 },
  );

  it.live(
    "a projection deletes the inputs it handled, and a view keeps its input log",
    () => {
      const disk: Disk = { objects: new Map() };
      return Effect.gen(function* () {
        const ledgers = yield* Ledger;
        const first = yield* ledgers.send(new BookMany({ id: "main", count: 5 }));
        yield* LinesWriter.caughtUp(first, { timeout: "30 seconds" });
        const projection = [...disk.objects.values()].find(
          (saved) => saved.cls.includes("LinesWriter") && saved.data.has("meta"),
        )!;
        // As 2.0.0-beta.87 and earlier left a key: every input it handled.
        for (let position = 1; position <= 5; position++)
          projection.data.set(`in:${position.toString().padStart(12, "0")}`, { position });
        projection.data.delete("in-pruned");

        const second = yield* ledgers.send(new BookMany({ id: "main", count: 1 }));
        yield* LinesWriter.caughtUp(second, { timeout: "30 seconds" });
        expect([...projection.data.keys()].filter((key) => key.startsWith("in:"))).toEqual([]);
        // A rewrite folds a view key's inputs again: it keeps every one.
        yield* (yield* Totals).get(Ledger.ref("main"), {
          atLeast: { stream: second.stream, version: second.version },
        });
        expect(keysIn(disk, "/main", ["in:"]).length).toBeGreaterThanOrEqual(6);
      }).pipe(Effect.scoped, Effect.provide(booksOn(disk)));
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
          .send(new BookMany({ id: Ledger.ref("gated").id, count: 1 }))
          .pipe(Effect.timeout("5 seconds"));
        expect(receipt.version).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(gated));
    },
    { timeout: 30_000 },
  );
});

// ---------------------------------------------------------------- one projection key fed by many sources

class Counted extends Domain.Event("Counted", { n: Schema.Number }) {}
class Count extends Domain.Command("Count", {
  input: { id: Schema.String },
  events: [Counted],
}) {}
class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ count: Schema.Number }),
  initial: { count: 0 },
  commands: [Count],
  keyOf: (command) => command.id,
  decide: { Count: (counter) => [new Counted({ n: counter.count + 1 })] },
  evolve: { Counted: (_, e) => ({ count: e.n }) },
}) {}
/** Every counter feeds one key. */
class AllCounts extends Domain.Projection("AllCounts", {
  from: [Counter],
  key: Schema.String,
  keyOf: { Counter: () => "all" },
  on: [Counted],
}) {}
class Counting extends Domain.Model("Counting", {
  aggregates: [Counter],
  projections: [AllCounts],
}) {}
/** The same model before the projection was deployed: the same objects. */
class CountingBefore extends Domain.Model("Counting", { aggregates: [Counter] }) {}

/** The key's class, and the one a `version: 1` deploy uses. */
const COUNTS = "Counting.AllCountsProjection";
const COUNTS_V1 = `${COUNTS}V1`;

/** A sim host for one test, with what the projection's handler ran and a switch to fail it. */
const countingSim = (
  options: {
    readonly failPut?: (key: string) => boolean;
    readonly inputGate?: boolean;
    /** Answers true for a call between objects that should fail, by its method. */
    readonly failCall?: (method: string) => boolean;
  } = {},
) => {
  const stats: Stats = { rowsRead: 0, bytesWritten: 0 };
  /** What the key's object was sent, as a counter's outbox sends it. */
  const received: Array<Record<string, unknown>> = [];
  const sim = simHost(stats, {
    ...options,
    intercept: (call, run) => {
      if (call.cls.startsWith(COUNTS) && call.method === "receive") {
        received.push(call.args[1] as Record<string, unknown>);
      }
      if (options.failCall?.(call.method)) return Effect.die(new Error(`${call.method} failed`));
      return run;
    },
  });
  const handled: Array<string> = [];
  const store = { failing: false, attempts: 0, millisPerBatch: 0 };
  const layer = (version = 0, size = 100) =>
    Counting.layer(
      AllCounts.toLayer(
        Effect.succeed(
          Effect.fn(function* (batch) {
            store.attempts += 1;
            if (store.failing) return yield* Effect.die(new Error("the store is down"));
            if (store.millisPerBatch > 0) yield* Effect.sleep(store.millisPerBatch);
            for (const { envelope } of batch) handled.push(`${envelope.stream}#${envelope.seq}`);
          }),
        ),
        { batch: { size }, ...(version > 0 ? { version } : {}) },
      ),
    ).pipe(
      Layer.provideMerge(DurableObjects.makePlatform(sim.host)),
      Layer.provideMerge(SecureRandom.layerWebCrypto),
    );
  const before = CountingBefore.layer(Layer.empty).pipe(
    Layer.provideMerge(DurableObjects.makePlatform(sim.host)),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );
  /** The key's stored rows. */
  const rows = (cls = COUNTS) => sim.disk.objects.get(`${cls}/all`)?.data ?? new Map();
  /** The key's rows under `prefix`, by what follows it. */
  const prefixed = (prefix: string, cls = COUNTS) =>
    Object.fromEntries(
      [...rows(cls)]
        .filter(([row]) => row.startsWith(prefix))
        .map(([row, value]) => [row.slice(prefix.length), value]),
    );
  const meta = (cls = COUNTS) => rows(cls).get("meta") as Record<string, unknown>;
  /** The keys the run's root still has to tell that every source's history is in. */
  const waiting = () =>
    [...sim.disk.objects.values()].flatMap((object) =>
      [...object.data.keys()].filter((row) => row.startsWith("rw:")),
    );
  /** A failed drain has let go of the key: the next one runs at once, not after the lease. */
  const released = eventually(() => !rows().has("drain-lease"));
  /** Deliver to the key directly, as a counter's outbox does (at least once, so again too). */
  const receive = (delivery: unknown, cls = COUNTS) =>
    sim.call(cls, "all", "receive", "all", delivery);
  const checkpoints = (sources?: ReadonlyArray<string>, cls = COUNTS) =>
    sim.call(
      cls,
      "all",
      "checkpoints",
      ...(sources === undefined ? [] : [sources]),
    ) as Effect.Effect<Record<string, number>, unknown>;
  return {
    sim,
    stats,
    received,
    handled,
    store,
    layer,
    before,
    rows,
    prefixed,
    meta,
    waiting,
    released,
    receive,
    checkpoints,
  };
};

/** A delivery from counter `id` as its outbox sends one. */
const counted = (id: string, seq: number) => ({
  target: { kind: "projection", name: "AllCounts" },
  key: "all",
  source: `Counter/${id}`,
  seq,
  origin: "Counter",
  tag: "Counted",
  event: { _tag: "Counted", n: seq },
  envelope: {
    id,
    stream: `Counter/${id}`,
    seq,
    at: Date.now(),
    commandId: `c-${id}-${seq}`,
    correlationId: `c-${id}-${seq}`,
  },
});

/** Count once on counter `id`, and wait until the key has handled it. */
const count = Effect.fn(function* (id: string) {
  const receipt = yield* (yield* Counter).send(new Count({ id }));
  yield* AllCounts.caughtUp(receipt, { timeout: "20 seconds" });
  return receipt;
});

/** Changes each counter's first count, and keeps the others. */
class Recount extends Domain.Rewrite("Recount", {
  of: Counter,
  events: { Counted: (e) => (e.n === 1 ? new Counted({ n: 100 }) : e) },
}) {}
class Recounting extends Domain.Model("Recounting", {
  aggregates: [Counter],
  projections: [AllCounts],
  rewrites: [Recount],
}) {}

describe("a projection key's first input", { tags: ["unit"] }, () => {
  it.live(
    "is handled as soon as the run has every source's history: the run tells the key",
    () => {
      const t = countingSim();
      return Effect.gen(function* () {
        // The key holds its first input until the run is past its barrier. No scanner
        // pushed it history, so no scanner tells it: it asks the run, which does.
        const receipt = yield* (yield* Counter).send(new Count({ id: "a" }));
        yield* AllCounts.caughtUp(receipt, { timeout: "2 seconds" });
        expect(t.handled).toEqual(["Counter/a#1"]);
        expect(t.waiting()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 30_000 },
  );

  it.live(
    "is handled once the run reaches a key it could not tell at first",
    () => {
      const failing = { left: 1 };
      const t = countingSim({
        failCall: (method) => method === "bfConsumerReady" && failing.left-- > 0,
      });
      return Effect.gen(function* () {
        const receipt = yield* (yield* Counter).send(new Count({ id: "a" }));
        yield* AllCounts.caughtUp(receipt, { timeout: "10 seconds" });
        expect(failing.left).toBeLessThan(1);
        expect(t.handled).toEqual(["Counter/a#1"]);
        expect(t.waiting()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 30_000 },
  );
});

describe("a projection key fed by many sources", { tags: ["unit"] }, () => {
  it.live(
    "keeps meta to scalars, and a cursor row per source for intake and checkpoints",
    () => {
      const t = countingSim();
      return Effect.gen(function* () {
        yield* count("a");
        yield* count("b");
        yield* count("a");
        expect(t.handled).toEqual(["Counter/a#1", "Counter/b#1", "Counter/a#2"]);
        expect(Object.keys(t.meta()).sort()).toEqual([
          "accepted",
          "generation",
          "key",
          "processed",
        ]);
        expect(t.meta()).toMatchObject({ key: "all", accepted: 3, processed: 3 });
        expect(t.prefixed("intake:")).toEqual({ "Counter/a": 2, "Counter/b": 1 });
        expect(t.prefixed("ckpt:")).toEqual({ "Counter/a": 2, "Counter/b": 1 });
        // A handled input leaves the log.
        expect(t.prefixed("in:")).toEqual({});
        // The deliveries these tests send are shaped like the ones a counter sent.
        const sent = t.received[0]!;
        expect(sent).toMatchObject({ ...counted("a", 1), envelope: expect.any(Object) });
        expect(Object.keys(sent).sort()).toEqual(Object.keys(counted("a", 1)).sort());
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 60_000 },
  );

  it.live(
    "drops a delivery it has accepted, by source and seq",
    () => {
      const t = countingSim();
      return Effect.gen(function* () {
        yield* count("a");
        yield* count("a");
        // The outbox sends seq 2 again, then an older one arrives late.
        yield* t.receive(counted("a", 2));
        yield* t.receive(counted("a", 1));
        yield* t.receive(counted("a", 3));
        yield* eventually(() => t.handled.length === 3);
        yield* Effect.sleep("50 millis");
        expect(t.handled).toEqual(["Counter/a#1", "Counter/a#2", "Counter/a#3"]);
        expect(t.meta()).toMatchObject({ accepted: 3 });
        expect(t.prefixed("intake:")).toEqual({ "Counter/a": 3 });
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 60_000 },
  );

  it.effect("a drain that runs longer than its lease is never joined by a second one", () => {
    const t = countingSim();
    /** Let virtual time pass, a second at a time, until `done`. */
    const until = Effect.fn(function* (done: () => boolean, seconds: number) {
      for (let s = 0; s < seconds && !done(); s++) {
        yield* TestClock.adjust("1 second");
        yield* TestClock.withLive(Effect.sleep("1 millis"));
      }
    });
    return Effect.gen(function* () {
      // The key's first input, through the model, which begins the projection's backfill.
      const first = yield* Effect.forkChild((yield* Counter).send(new Count({ id: "k0" })));
      yield* until(() => t.handled.length === 1, 120);
      yield* Fiber.join(first);
      expect(t.handled).toEqual(["Counter/k0#1"]);
      // 90 more at a second each: one drain needs longer than a lease lasts.
      t.store.millisPerBatch = 1_000;
      for (let n = 1; n <= 90; n++) yield* t.receive(counted(`k${n}`, 1));
      yield* until(() => t.handled.length >= 91, 240);
      // Each input once: no drain started beside the one still running.
      expect(t.handled).toHaveLength(91);
      expect(new Set(t.handled).size).toBe(91);
    }).pipe(Effect.scoped, Effect.provide(t.layer(0, 1)));
  });

  it.live(
    "after an eviction, redelivered inputs are dropped and the log resumes in order",
    () => {
      const t = countingSim();
      return Effect.gen(function* () {
        yield* count("a");
        // Accepted, but the handler fails, and then the instance is gone.
        t.store.failing = true;
        const attempts = t.store.attempts;
        yield* t.receive(counted("b", 1));
        yield* t.receive(counted("c", 1));
        yield* eventually(() => t.store.attempts > attempts);
        yield* t.released;
        yield* t.sim.evict;
        t.store.failing = false;
        // The senders, not knowing, send both again; then something new arrives.
        yield* t.receive(counted("b", 1));
        yield* t.receive(counted("c", 1));
        expect(t.meta()).toMatchObject({ accepted: 3 });
        yield* t.receive(counted("b", 2));
        yield* eventually(() => t.handled.length === 4);
        expect(t.handled).toEqual(["Counter/a#1", "Counter/b#1", "Counter/c#1", "Counter/b#2"]);
        expect(t.prefixed("ckpt:")).toEqual({ "Counter/a": 1, "Counter/b": 2, "Counter/c": 1 });
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 60_000 },
  );

  it.live(
    "a checkpoint write that fails leaves neither cursor rows nor progress, and the batch runs again",
    () => {
      const failing = { next: 0 };
      // The drain's `meta` write for a batch with b in it fails once, after its `ckpt:` rows.
      const t = countingSim({
        failPut: (key) =>
          key === "meta" &&
          t.rows().has("ckpt:Counter/b") &&
          failing.next > 0 &&
          failing.next-- > 0,
      });
      return Effect.gen(function* () {
        yield* count("a");
        failing.next = 1;
        yield* t.receive(counted("b", 1));
        yield* eventually(() => failing.next === 0);
        yield* t.released;
        // Rolled back together: no checkpoint for b, progress still at a's input.
        expect(t.prefixed("ckpt:")).toEqual({ "Counter/a": 1 });
        expect(t.meta()).toMatchObject({ processed: 1 });
        // The next drain runs b again (at least once), then c.
        yield* t.receive(counted("c", 1));
        yield* eventually(() => t.handled.includes("Counter/c#1"));
        expect(t.handled).toEqual(["Counter/a#1", "Counter/b#1", "Counter/b#1", "Counter/c#1"]);
        expect(t.prefixed("ckpt:")).toEqual({ "Counter/a": 1, "Counter/b": 1, "Counter/c": 1 });
        expect(t.meta()).toMatchObject({ processed: 3 });
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 60_000 },
  );

  it.live(
    "a log from an earlier generation starts over, and its cursor rows with it",
    () => {
      const t = countingSim();
      // What an earlier generation left in this key: a log, and cursors that would drop seq 1.
      t.sim.disk.objects.set(`${COUNTS_V1}/all`, {
        cls: COUNTS_V1,
        name: "all",
        alarm: undefined,
        data: new Map<string, unknown>([
          ["meta", { key: "all", accepted: 1, processed: 1, generation: 0 }],
          ["in:000000000001", { position: 1, delivery: counted("a", 9), at: 0 }],
          ["intake:Counter/a", 9],
          ["ckpt:Counter/a", 9],
          ["intake:Counter/old", 4],
          ["ckpt:Counter/old", 4],
        ]),
      });
      return Effect.gen(function* () {
        // Before anything is written, the earlier generation's checkpoints read as none.
        expect(yield* t.checkpoints(undefined, COUNTS_V1)).toEqual({});
        expect(yield* t.checkpoints(["Counter/a"], COUNTS_V1)).toEqual({});
        yield* count("a");
        expect(t.handled).toEqual(["Counter/a#1"]);
        expect(t.prefixed("intake:", COUNTS_V1)).toEqual({ "Counter/a": 1 });
        expect(t.prefixed("ckpt:", COUNTS_V1)).toEqual({ "Counter/a": 1 });
        expect(t.meta(COUNTS_V1)).toMatchObject({ accepted: 1, processed: 1, generation: 1 });
        expect(yield* t.checkpoints(undefined, COUNTS_V1)).toEqual({ "Counter/a": 1 });
      }).pipe(Effect.scoped, Effect.provide(t.layer(1)));
    },
    { timeout: 60_000 },
  );

  it.live(
    "a meta written with the per-source maps still dedupes, and moves them to rows on its next write",
    () => {
      const t = countingSim();
      // 300 sources: moving them writes 600 rows, more than one put takes.
      const old: Record<string, number> = { "Counter/a": 1 };
      for (let i = 0; i < 299; i++) old[`Counter/x${i}`] = 3;
      return Effect.gen(function* () {
        yield* count("a");
        yield* t.sim.evict;
        // Rewrite the key as earlier code stored it: the maps in `meta`, no cursor rows.
        const data = t.rows();
        for (const row of [...data.keys()]) {
          if (row.startsWith("intake:") || row.startsWith("ckpt:")) data.delete(row);
        }
        const scalars = { ...t.meta() };
        const taken = { "Counter/x0": 4 };
        data.set("meta", { ...scalars, intake: old, checkpoints: old, taken });

        expect(yield* t.checkpoints()).toEqual(old);
        expect(yield* t.checkpoints(["Counter/a", "Counter/none"])).toEqual({ "Counter/a": 1 });
        // Counter a's first event was handled before: sent again, it is dropped.
        yield* t.receive(counted("a", 1));
        expect(t.meta()).toEqual(scalars);
        expect(t.prefixed("intake:")).toEqual(old);
        expect(t.prefixed("ckpt:")).toEqual(old);
        expect(t.prefixed("taken:")).toEqual(taken);
        yield* t.receive(counted("x7", 3));
        yield* t.receive(counted("a", 2));
        yield* eventually(() => t.handled.length === 2);
        expect(t.handled).toEqual(["Counter/a#1", "Counter/a#2"]);
        expect(t.prefixed("ckpt:")["Counter/a"]).toBe(2);
        expect(yield* t.checkpoints()).toEqual({ ...old, "Counter/a": 2 });
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 60_000 },
  );

  it.live(
    "checkpoints reads every source's rows past one page, or only the sources asked for",
    () => {
      const t = countingSim();
      const many = Array.from({ length: 1_203 }, (_, i) => `x${i}`);
      return Effect.gen(function* () {
        yield* count("a");
        for (const id of many) yield* t.receive(counted(id, 1));
        yield* eventually(() => t.handled.length === 1 + many.length, "30 seconds");
        yield* Effect.sleep("50 millis");
        const all = yield* t.checkpoints();
        expect(Object.keys(all).length).toBe(1 + many.length);
        expect(all["Counter/x1202"]).toBe(1);
        // What `caughtUp` asks for: the streams it waits on, a row each.
        const asked = yield* rowsReadBy(t.stats, t.checkpoints(["Counter/a", "Counter/none"]));
        expect(asked.result).toEqual({ "Counter/a": 1 });
        expect(asked.rows).toBeLessThanOrEqual(3);
        // And read-your-writes still holds.
        yield* count("a");
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 60_000 },
  );

  it.live(
    "history committed before the projection was deployed reaches the key through the same intake",
    () => {
      const t = countingSim();
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const counters = yield* Counter;
          yield* counters.send(new Count({ id: "a" }));
          yield* counters.send(new Count({ id: "a" }));
          yield* counters.send(new Count({ id: "b" }));
        }).pipe(Effect.scoped, Effect.provide(t.before));
        yield* t.sim.evict;
        // The deploy that adds the projection: the first live input starts the backfill of a and b.
        yield* Effect.gen(function* () {
          yield* count("c");
          yield* eventually(() => t.handled.length === 4);
          expect([...t.handled].sort()).toEqual([
            "Counter/a#1",
            "Counter/a#2",
            "Counter/b#1",
            "Counter/c#1",
          ]);
          expect(t.handled.indexOf("Counter/a#1")).toBeLessThan(t.handled.indexOf("Counter/a#2"));
          yield* count("a");
          expect(t.handled.at(-1)).toBe("Counter/a#3");
          expect(t.handled.length).toBe(5);
          expect(t.prefixed("ckpt:")).toEqual({ "Counter/a": 3, "Counter/b": 1, "Counter/c": 1 });
        }).pipe(Effect.scoped, Effect.provide(t.layer()));
      });
    },
    { timeout: 90_000 },
  );

  it.live(
    "what one delivery writes does not grow with the sources the key has heard from",
    () => {
      const t = countingSim();
      return Effect.gen(function* () {
        yield* count("warm");
        const perDelivery = Effect.fn(function* (from: number, n: number) {
          const before = t.stats.bytesWritten!;
          for (let i = from; i < from + n; i++) yield* t.receive(counted(`s${i}`, 1));
          yield* eventually(() => t.handled.length === 1 + from + n, "30 seconds");
          yield* Effect.sleep("20 millis");
          return (t.stats.bytesWritten! - before) / n;
        });
        const small = yield* perDelivery(0, 50);
        yield* perDelivery(50, 1_950);
        const large = yield* perDelivery(2_000, 50);
        // With both maps in `meta`, each delivery rewrote ~2,000 entries twice (> 100 kB).
        expect(large).toBeLessThan(small * 1.2);
        expect(large).toBeLessThan(5_000);
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 90_000 },
  );

  it.live(
    "a key behind an input gate, as Rivet runs one, writes its checkpoints in a transaction",
    () => {
      const t = countingSim({ inputGate: true });
      return Effect.gen(function* () {
        // The drain's checkpoint write is a transaction, which holds the gate.
        yield* count("a").pipe(Effect.timeout("20 seconds"));
        yield* t.sim.evict;
        yield* count("b").pipe(Effect.timeout("20 seconds"));
        yield* count("a").pipe(Effect.timeout("20 seconds"));
        expect(t.handled).toEqual(["Counter/a#1", "Counter/b#1", "Counter/a#2"]);
        expect(t.prefixed("ckpt:")).toEqual({ "Counter/a": 2, "Counter/b": 1 });
      }).pipe(Effect.scoped, Effect.provide(t.layer()));
    },
    { timeout: 90_000 },
  );

  it.live(
    "a rewrite's revisions of handled events leave each source's checkpoint where it was",
    () => {
      const sim = simHost({ rowsRead: 0 });
      const revised: Array<string> = [];
      const layer = Recounting.layer(
        AllCounts.toLayer(
          Effect.succeed({
            write: () => Effect.void,
            rewrite: Effect.fn(function* (batch) {
              for (const { envelope } of batch) revised.push(`${envelope.stream}#${envelope.seq}`);
            }),
          }),
          { batch: { size: 100 } },
        ),
      ).pipe(
        Layer.provideMerge(DurableObjects.makePlatform(sim.host)),
        Layer.provideMerge(SecureRandom.layerWebCrypto),
      );
      const ckpt = () =>
        Object.fromEntries(
          [...(sim.disk.objects.get("Recounting.AllCountsProjection/all")?.data ?? new Map())]
            .filter(([row]) => row.startsWith("ckpt:"))
            .map(([row, seq]) => [row.slice("ckpt:".length), seq]),
        );
      return Effect.gen(function* () {
        const counters = yield* Counter;
        yield* count("a");
        const last = yield* count("a");
        yield* count("b");
        expect(ckpt()).toEqual({ "Counter/a": 2, "Counter/b": 1 });
        // Only seq 1 changes: its revision, then the rewrite's `done` (seq 0), reach the key.
        yield* counters.rewritten(yield* counters.rewrite("a", new Recount()));
        expect(revised).toEqual(["Counter/a#1"]);
        expect(ckpt()).toEqual({ "Counter/a": 2, "Counter/b": 1 });
        yield* AllCounts.caughtUp(last, { timeout: "5 seconds" });
        yield* count("a");
        expect(ckpt()).toEqual({ "Counter/a": 3, "Counter/b": 1 });
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
    { timeout: 60_000 },
  );
});
