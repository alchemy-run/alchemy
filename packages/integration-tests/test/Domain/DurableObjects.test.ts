import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import { InMemory } from "@alchemy.run/domain/InMemory";
import type { AggregateStore, ModelHost, StoredEvent } from "@alchemy.run/domain/Platform";
import * as DomainRivet from "@alchemy.run/domain/Rivet";
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

// ---------------------------------------------------------------- reading a model's instances and logs

/**
 * A platform that keeps the host it built for the model and the store of each
 * aggregate, so a test reads through them as a caller of the platform does.
 */
const spyingOn = (platform: Layer.Layer<Domain.Platform, never, SecureRandom.SecureRandom>) => {
  const seen = {
    host: undefined as ModelHost | undefined,
    stores: new Map<string, AggregateStore>(),
  };
  const layer = Layer.effect(
    Domain.Platform,
    Effect.gen(function* () {
      const inner = yield* Domain.Platform;
      return Domain.Platform.of({
        model: (hosted) =>
          inner.model(hosted).pipe(
            Effect.map((host) => {
              const spy: ModelHost = {
                ...host,
                aggregate: (aggregate, kit) =>
                  host
                    .aggregate(aggregate, kit)
                    .pipe(
                      Effect.tap((store) =>
                        Effect.sync(() => seen.stores.set(aggregate.aggregateName, store)),
                      ),
                    ),
              };
              seen.host = spy;
              return spy;
            }),
          ),
      });
    }),
  ).pipe(Layer.provide(platform));
  return { seen, layer };
};

/**
 * A host of the Imports model, built on its own platform, with the store of each
 * of its aggregates and the context a test runs its clients in.
 */
const hostOf = (platform: Layer.Layer<Domain.Platform, never, SecureRandom.SecureRandom>) =>
  Effect.gen(function* () {
    const { seen, layer } = spyingOn(platform);
    const context = yield* Layer.build(importsOn(layer));
    return {
      context,
      store: (aggregate: string) => seen.stores.get(aggregate)!,
    };
  });

/** Wait until the Audit instance has seen `count` bookings. */
const untilAudited = (id: string, count: number) =>
  Effect.gen(function* () {
    const audits = yield* Audit;
    while ((yield* audits.get(id)).seen.length < count) yield* Effect.sleep("20 millis");
  }).pipe(Effect.timeout("15 seconds"));

/** Every page of a source's instances, `limit` rows a page, until the cursor ends. */
const pagesOf = (
  list: (
    source: string,
    after: string | undefined,
    limit: number,
  ) => Effect.Effect<{
    readonly rows: ReadonlyArray<{ readonly id: string }>;
    readonly next?: string;
  }>,
  source: string,
  limit: number,
) =>
  Effect.gen(function* () {
    const ids: Array<string> = [];
    let pages = 0;
    let after: string | undefined;
    do {
      const page = yield* list(source, after, limit);
      expect(page.rows.length).toBeLessThanOrEqual(limit);
      ids.push(...page.rows.map((row) => row.id));
      after = page.next;
      pages += 1;
    } while (after !== undefined);
    return { ids, pages };
  });

/** Page the source's instances until `count` distinct ones are listed: an instance lists itself after its first commit. */
const untilListed = (
  list: Parameters<typeof pagesOf>[0],
  source: string,
  limit: number,
  count: number,
) =>
  Effect.gen(function* () {
    while (true) {
      const listed = yield* pagesOf(list, source, limit);
      if (new Set(listed.ids).size >= count) return listed;
      yield* Effect.sleep("20 millis");
    }
  }).pipe(Effect.timeout("15 seconds"));

const LEDGERS = Array.from({ length: 7 }, (_, i) => `ledger-${i}`);

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
    it.live(
      `a model's instances are read a page at a time, and an instance's stored events by seq, on ${name}`,
      () => {
        const { seen, layer } = spyingOn(platform());
        return Effect.gen(function* () {
          const ledgers = yield* Ledger;
          for (const id of LEDGERS) yield* ledgers.send(new BookMany({ id, count: 3 }));
          const host = seen.host!;
          const store = seen.stores.get("Ledger")!;

          // Pages of two reach every instance, each at least once, and keep their cursor.
          const listed = yield* untilListed(host.instances!, "Ledger", 2, LEDGERS.length);
          expect([...new Set(listed.ids)].sort()).toEqual(LEDGERS);
          expect(listed.pages).toBeGreaterThanOrEqual(Math.ceil(LEDGERS.length / 2));
          // One page takes them all, and a name that is no source lists none.
          expect((yield* host.instances!("Ledger", undefined, 100)).next).toBeUndefined();
          expect((yield* host.instances!("Unknown", undefined, 100)).rows).toEqual([]);

          // An instance's log, as stored: its events in seq order, from after a seq.
          const rows = yield* store.log!("ledger-3", 0, 100);
          expect(rows.map((row) => row.envelope.seq)).toEqual([1, 2, 3]);
          expect(rows.map((row) => row.event)).toMatchObject([
            { _tag: "Booked", n: 1 },
            { _tag: "Booked", n: 2 },
            { _tag: "Booked", n: 3 },
          ]);
          expect(rows[0]!.envelope).toMatchObject({ stream: "Ledger/ledger-3", seq: 1 });
          expect((yield* store.log!("ledger-3", 1, 1)).map((row) => row.envelope.seq)).toEqual([2]);
          expect(yield* store.log!("ledger-3", 3, 10)).toEqual([]);

          // Reading an instance that was never written creates nothing: it is never listed.
          expect(yield* store.log!("never-written", 0, 10)).toEqual([]);
          yield* Effect.sleep("300 millis");
          expect(
            new Set((yield* pagesOf(host.instances!, "Ledger", 100)).ids).has("never-written"),
          ).toBe(false);
          expect(yield* ledgers.get("ledger-3")).toEqual({ count: 3 });
        }).pipe(
          Effect.scoped,
          Effect.provide(
            BooksBefore.layer(Layer.empty).pipe(
              Layer.provideMerge(layer),
              Layer.provideMerge(SecureRandom.layerWebCrypto),
            ),
          ),
        );
      },
      { timeout: 60_000 },
    );
  }

  for (const [name, platform] of [
    ["Durable Objects", () => DurableObjects.makePlatform(simHost({ rowsRead: 0 }).host)],
    ["the in-memory platform", () => InMemory],
  ] as const) {
    it.live(
      `an instance's stored log is restored as stored on another host, on ${name}`,
      () =>
        Effect.gen(function* () {
          const source = yield* hostOf(platform());
          const target = yield* hostOf(platform());

          // The source decides two commands: its log has their ids, and the policy reacted.
          yield* Effect.gen(function* () {
            const ledgers = yield* Ledger;
            yield* ledgers.send(new BookMany({ id: "moved", count: 2 }), { commandId: "cmd-a" });
            yield* ledgers.send(new BookMany({ id: "moved", count: 1 }), { commandId: "cmd-b" });
            yield* ledgers.send(new BookMany({ id: "other", count: 1 }), { commandId: "cmd-c" });
            yield* untilAudited("moved", 3);
          }).pipe(Effect.provide(source.context));
          const rows = yield* source.store("Ledger").log!("moved", 0, 100);
          expect(rows.map((row) => row.envelope.commandId)).toEqual(["cmd-a", "cmd-a", "cmd-b"]);
          const store = target.store("Ledger");
          const receipt = {
            stream: "Ledger/moved",
            version: 3,
            events: rows.map((r) => r.event),
            reply: null,
          };

          // Refused, it leaves the instance as it was: nothing stored, nothing listed.
          const refusal = (rows: ReadonlyArray<StoredEvent>, expectedVersion = 0) =>
            store.restore!("moved", rows, { expectedVersion }).pipe(Effect.flip);
          expect(yield* refusal(rows, 2)).toMatchObject({
            _tag: "RestoreRefused",
            aggregate: "Ledger",
            id: "moved",
            reason: "version",
          });
          expect(yield* refusal([rows[0]!, rows[2]!])).toMatchObject({ reason: "seqGap" });
          expect(yield* refusal(rows.slice(1))).toMatchObject({ reason: "seqGap" });
          expect(
            yield* refusal(
              rows.map((row) => ({
                ...row,
                envelope: { ...row.envelope, id: "x", stream: "Ledger/x" },
              })),
            ),
          ).toMatchObject({ reason: "wrongInstance" });
          expect(
            yield* refusal(rows.map((row) => ({ ...row, event: { _tag: "Nope", n: 1 } }))),
          ).toMatchObject({ reason: "undecodable" });
          expect(
            yield* refusal(rows.map((row) => ({ ...row, event: { _tag: "Booked", n: "one" } }))),
          ).toMatchObject({ reason: "undecodable" });
          expect(
            yield* refusal(
              rows.map((row) => ({ ...row, envelope: { ...row.envelope, at: "now" } }) as never),
            ),
          ).toMatchObject({ reason: "undecodable" });
          // The last row is bad: the ones before it are not taken either.
          expect(
            yield* refusal([rows[0]!, rows[1]!, { ...rows[2]!, event: { _tag: "Nope" } }]),
          ).toMatchObject({ reason: "undecodable" });
          expect(yield* store.log!("moved", 0, 100)).toEqual([]);
          expect((yield* target.store("Ledger").log!("moved", 0, 100)).length).toBe(0);

          // Taken, every row is as the source stored it.
          expect(yield* store.restore!("moved", rows, { expectedVersion: 0 })).toEqual(receipt);
          expect(yield* store.log!("moved", 0, 100)).toEqual(rows);
          expect(yield* store.state("moved")).toEqual(yield* source.store("Ledger").state("moved"));

          // Again, the same rows: the receipt, and nothing written. Other rows at those seqs are refused.
          expect(yield* store.restore!("moved", rows, { expectedVersion: 0 })).toEqual(receipt);
          expect(yield* store.log!("moved", 0, 100)).toEqual(rows);
          expect(
            yield* store.restore!(
              "moved",
              rows.map((row) => ({ ...row, event: { _tag: "Booked", n: 9 } })),
              {
                expectedVersion: 0,
              },
            ).pipe(Effect.flip),
          ).toMatchObject({ reason: "version" });
          // Nothing to restore from where the instance already is.
          expect((yield* store.restore!("moved", [], { expectedVersion: 3 })).version).toBe(3);

          yield* Effect.gen(function* () {
            const ledgers = yield* Ledger;
            const atLeast = { stream: "Ledger/moved", version: 3 };
            // The view has the restored history, the policy did not react to it,
            // and a command is decided from the restored state, as the next event.
            expect(yield* (yield* Totals).get(Ledger.ref("moved"), { atLeast })).toEqual(
              Option.some({ count: 3 }),
            );
            expect(yield* ledgers.get("moved")).toEqual({ count: 3 });
            const next = yield* ledgers.send(new BookMany({ id: "moved", count: 1 }), {
              commandId: "cmd-d",
            });
            expect(next.version).toBe(4);
            yield* untilAudited("moved", 1);
            expect((yield* (yield* Audit).get("moved")).seen).toEqual([4]);
          }).pipe(Effect.provide(target.context));
        }).pipe(Effect.scoped),
      { timeout: 60_000 },
    );
  }

  it.live(
    "an instance is restored from outside its host by the names its host gives its objects",
    () =>
      Effect.gen(function* () {
        const source = yield* hostOf(DurableObjects.makePlatform(simHost({ rowsRead: 0 }).host));
        const sim = simHost({ rowsRead: 0 });
        const target = yield* hostOf(DurableObjects.makePlatform(sim.host));
        yield* Effect.provide(
          Effect.gen(function* () {
            yield* (yield* Ledger).send(new BookMany({ id: "m-1", count: 2 }), {
              commandId: "cmd-a",
            });
          }),
          source.context,
        );
        const rows = yield* source.store("Ledger").log!("m-1", 0, 100);
        const hosted = { modelName: "Imports", id: {}, sagas: [], legacyData: false };
        const direct = DurableObjects.restoreModel((cls, key) =>
          sim.host.lookup!(hosted, cls)!.getByName(key),
        );
        const multiplexed = DomainRivet.modelRestorer(
          {
            getByName: (name: string) => {
              const { className, key } = DurableObjects.parseMultiplexedName(name)!;
              return sim.host.lookup!(hosted, className.slice("Imports.".length))!.getByName(key);
            },
          } as never,
          "Imports",
        );
        // The target's own objects take it, refuse it and recognise it again.
        const refused = yield* direct
          .restore("Ledger", "m-1", rows, { expectedVersion: 1 })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "RestoreRefused", reason: "version" });
        expect((yield* direct.restore("Ledger", "m-1", rows, { expectedVersion: 0 })).version).toBe(
          2,
        );
        expect(
          (yield* multiplexed.restore("Ledger", "m-1", rows, { expectedVersion: 0 })).version,
        ).toBe(2);
        expect(yield* target.store("Ledger").log!("m-1", 0, 100)).toEqual(rows);
        // A second instance, through the Rivet names.
        const more = yield* multiplexed.restore(
          "Ledger",
          "m-2",
          rows.map((row) => ({
            ...row,
            envelope: { ...row.envelope, id: "m-2", stream: "Ledger/m-2" },
          })),
          { expectedVersion: 0 },
        );
        expect(more).toMatchObject({ stream: "Ledger/m-2", version: 2 });
        const moved = Effect.gen(function* () {
          return yield* (yield* Ledger).get("m-2");
        });
        expect(yield* Effect.provide(moved, target.context)).toEqual({ count: 2 });
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.live(
    "a model is read from outside its host by the names its host gives its objects",
    () => {
      const sim = simHost({ rowsRead: 0 });
      const hosted = { modelName: "Books", id: {}, sagas: [], legacyData: false };
      // What a caller reaches: one object per class and key, by the host's names.
      const direct = DurableObjects.readModel((cls, key) =>
        sim.host.lookup!(hosted, cls)!.getByName(key),
      );
      // The same objects, as one Rivet class holds them: `Books.LedgerAggregate/ledger-0`.
      const multiplexed = DomainRivet.modelReader(
        {
          getByName: (name: string) => {
            const { className, key } = DurableObjects.parseMultiplexedName(name)!;
            return sim.host.lookup!(hosted, className.slice("Books.".length))!.getByName(key);
          },
        } as never,
        "Books",
      );
      return Effect.gen(function* () {
        const ledgers = yield* Ledger;
        for (const id of LEDGERS) yield* ledgers.send(new BookMany({ id, count: 2 }));
        for (const reader of [direct, multiplexed]) {
          const listed = yield* untilListed(reader.instances, "Ledger", 3, LEDGERS.length);
          expect([...new Set(listed.ids)].sort()).toEqual(LEDGERS);
          const rows = yield* reader.log("Ledger", "ledger-5", 0, 100);
          expect(rows.map((row) => row.envelope.seq)).toEqual([1, 2]);
          expect(rows[1]!.envelope).toMatchObject({ stream: "Ledger/ledger-5", seq: 2 });
          expect(
            (yield* reader.log("Ledger", "ledger-5", 1, 100)).map((row) => row.envelope.seq),
          ).toEqual([2]);
          expect(yield* reader.log("Ledger", "never-written", 0, 100)).toEqual([]);
        }
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
});
