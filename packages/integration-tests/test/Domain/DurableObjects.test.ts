import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import { InMemory } from "@alchemy.run/domain/InMemory";
import * as Model from "@alchemy.run/domain/Model";
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

// ---------------------------------------------------------------- a purse that rejects

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
class Short extends Domain.Rejection("Short", {
  balance: Schema.Number,
  requested: Schema.Number,
}) {}
class Deposit extends Domain.Command("Deposit", {
  input: { id: Schema.String, amount: Schema.Number },
  events: [Deposited],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  input: { id: Schema.String, amount: Schema.Number },
  events: [Withdrawn],
  rejects: [Short],
}) {}
class Purse extends Domain.Aggregate("Purse", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  keyOf: (command) => command.id,
  decide: {
    Deposit: (_, { amount }) => [new Deposited({ amount })],
    Withdraw: (purse, { amount }) =>
      amount > purse.balance
        ? new Short({ balance: purse.balance, requested: amount })
        : [new Withdrawn({ amount })],
  },
  evolve: {
    Deposited: (purse, e) => ({ balance: purse.balance + e.amount }),
    Withdrawn: (purse, e) => ({ balance: purse.balance - e.amount }),
  },
}) {}

class Purses extends Domain.Model("Purses", { aggregates: [Purse] }) {}

const pursesOn = (platform: Layer.Layer<Domain.Platform, never, SecureRandom.SecureRandom>) =>
  Purses.layer(Layer.empty).pipe(
    Layer.provideMerge(platform),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );

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

  for (const [name, platform] of [
    ["Durable Objects", () => DurableObjects.makePlatform(simHost({ rowsRead: 0 }).host)],
    ["the in-memory platform", () => InMemory],
  ] as const) {
    it.live(
      `a command's receipt reads back, accepted or rejected, on ${name}`,
      () =>
        Effect.gen(function* () {
          const purses = yield* Purse;
          const store = (yield* Model.Internals).aggregates.get("Purse")!;
          expect(store.receipt).toBeDefined();

          // Nothing was sent: no receipt, on an instance nobody has written.
          expect(yield* store.receipt!("a", "never")).toBeUndefined();

          const refused = yield* purses
            .send(new Withdraw({ id: "a", amount: 5 }), { commandId: "w1" })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({ _tag: "Short", balance: 0, requested: 5 });
          expect(yield* store.receipt!("a", "w1")).toEqual({
            result: { _tag: "Rejected", rejection: { _tag: "Short", balance: 0, requested: 5 } },
            command: { tag: "Withdraw", input: { id: "a", amount: 5 } },
          });

          const paid = yield* purses.send(new Deposit({ id: "a", amount: 8 }), {
            commandId: "d1",
          });
          const accepted = yield* store.receipt!("a", "d1");
          expect(accepted?.command).toEqual({ tag: "Deposit", input: { id: "a", amount: 8 } });
          expect(accepted?.result).toMatchObject({
            _tag: "Accepted",
            receipt: { stream: "Purse/a", version: paid.version },
          });

          // The receipts belong to their instance.
          expect(yield* store.receipt!("b", "d1")).toBeUndefined();
        }).pipe(Effect.scoped, Effect.provide(pursesOn(platform()))),
      { timeout: 30_000 },
    );

    it.live(
      `a rejected command runs again when it is resent, and an accepted one does not, on ${name}`,
      () =>
        Effect.gen(function* () {
          const purses = yield* Purse;
          const store = (yield* Model.Internals).aggregates.get("Purse")!;
          const withdraw = new Withdraw({ id: "a", amount: 5 });

          yield* purses.send(withdraw, { commandId: "w1" }).pipe(Effect.flip);
          yield* purses.send(withdraw, { commandId: "w1" }).pipe(Effect.flip);

          // The balance now covers it: the same command id decides again.
          yield* purses.send(new Deposit({ id: "a", amount: 8 }));
          const paid = yield* purses.send(withdraw, { commandId: "w1" });
          expect(paid.version).toBe(2);
          expect((yield* store.receipt!("a", "w1"))?.result._tag).toBe("Accepted");

          // Now it is accepted: a resend answers that receipt and commits nothing.
          const again = yield* purses.send(withdraw, { commandId: "w1" });
          expect(again).toEqual(paid);
          expect(yield* purses.get(Purse.ref("a"))).toEqual({ balance: 3 });
        }).pipe(Effect.scoped, Effect.provide(pursesOn(platform()))),
      { timeout: 30_000 },
    );

    it.live(
      `a rejected command is not an executed one: its name can be armed and unscheduled, on ${name}`,
      () =>
        Effect.gen(function* () {
          const store = (yield* Model.Internals).aggregates.get("Purse")!;
          const meta = { commandId: "c1", context: {} };

          const sent = yield* store.send("a", { _tag: "Withdraw", id: "a", amount: 5 }, meta);
          expect(sent._tag).toBe("Rejected");

          // The rejected command id names an arming too: it ran nothing.
          yield* store.schedule("a", "c1", { _tag: "Deposit", id: "a", amount: 1 }, meta, {
            afterMillis: 3_600_000,
          });
          yield* store.unschedule("a", "c1");
          const again = yield* store.unschedule("a", "c1").pipe(Effect.flip);
          expect(again._tag).toBe("AlreadyCancelled");
        }).pipe(Effect.scoped, Effect.provide(pursesOn(platform()))),
      { timeout: 30_000 },
    );
  }
});
