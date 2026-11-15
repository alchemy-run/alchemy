import * as Domain from "@alchemy.run/domain";
import * as Export from "@alchemy.run/domain/Export";
import * as ExportStore from "@alchemy.run/domain/Export/Store";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

// ---------------------------------------------------------------- a bank

class Deposited extends Domain.Event("Deposited", { amount: Schema.Int, memo: Schema.String }) {}
class Withdrew extends Domain.Event("Withdrew", { amount: Schema.Int }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Int, memo: Schema.String },
  events: [Deposited],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Int },
  events: [Withdrew],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  decide: {
    Deposit: (_, { amount, memo }) => [new Deposited({ amount, memo })],
    Withdraw: (_, { amount }) => [new Withdrew({ amount })],
  },
  evolve: {
    Deposited: (s, e) => ({ balance: s.balance + e.amount }),
    Withdrew: (s, e) => ({ balance: s.balance - e.amount }),
  },
}) {}

// ---------------------------------------------------------------- the export

/** Every movement of every account, as a table in a store we own. */
class Ledger extends Export.Table(
  "Ledger",
  { from: [Account], key: Account, on: [Deposited, Withdrew] },
  {
    table: "ledger",
    metadata: { _export_memo: Export.Metadata.copy("event.memo", Schema.NullOr(Schema.String)) },
  },
) {}
class Lake extends Export.Store("Lake", { tables: [Ledger] }) {}

class Bank extends Domain.Model("Bank", { aggregates: [Account], projections: [Ledger] }) {}

/** The table's handler, placed in the lake. The lake itself comes from outside, so tests can read it too. */
const handlers = Ledger.layer().pipe(Layer.provide(Lake.place(Ledger)));

/** The rows the lake holds, decoded with the table's own read Schema, as its reader decodes them. */
const raw = Effect.gen(function* () {
  const reader = yield* Ledger.RawReader;
  const rows = yield* Stream.runCollect(reader.scan({})).pipe(Effect.orDie);
  return yield* Schema.decodeUnknownEffect(Schema.Array(Schema.toCodecJson(Ledger.Read)))(
    rows,
  ).pipe(Effect.orDie);
});

/** One memory lake per test, with the table placed in it for reading. */
const lake = Lake.place(Ledger).pipe(Layer.provideMerge(Lake.memory()));

const a1 = Account.ref("a1");
const b2 = Account.ref("b2");

describe("Domain Export", { tags: ["unit", "local"] }, () => {
  it.effect("exports each event as one row of its key, with its metadata", () =>
    Effect.gen(function* () {
      // The story stamps commits from 2026-01-01; the table stamps ingestion from the Effect clock.
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00.000Z"));
      yield* Story.make(Bank, { layer: handlers })(
        Story.when(a1, new Deposit({ amount: 50, memo: "salary" })),
        Story.then(a1, new Deposited({ amount: 50, memo: "salary" })),
        Story.when(a1, new Withdraw({ amount: 20 })),
        Story.then(a1, new Withdrew({ amount: 20 })),
        Story.when(b2, new Deposit({ amount: 5, memo: "gift" })),
        Story.then(b2, new Deposited({ amount: 5, memo: "gift" })),
      );
      const rows = yield* raw;
      expect(
        rows
          .map((row) => [
            row.key,
            row.position,
            row.envelope.seq,
            row.event._tag,
            row.event.amount,
            row._export_memo,
          ])
          .sort(),
      ).toEqual([
        ["a1", 1, 1, "Deposited", 50, "salary"],
        ["a1", 2, 2, "Withdrew", 20, null],
        ["b2", 1, 1, "Deposited", 5, "gift"],
      ]);
      for (const row of rows) {
        // The store recorded when the row arrived, and the lag from its commit to then.
        expect(row._export_lag_ms).toBe(
          DateTime.toEpochMillis(row._export_ingested_at) - DateTime.toEpochMillis(row.envelope.at),
        );
        expect(row._export_lag_ms).toBeGreaterThanOrEqual(0);
      }
    }).pipe(Effect.provide(lake), Effect.provide(RuntimeContext.phantom)),
  );

  it.effect("history recorded before the table reaches it", () =>
    Effect.gen(function* () {
      yield* Story.make(Bank, { layer: handlers })(
        Story.given(a1, new Deposited({ amount: 7, memo: "old" })),
      );
      expect((yield* raw).map((row) => row.event.amount)).toEqual([7]);
    }).pipe(Effect.provide(lake), Effect.provide(RuntimeContext.phantom)),
  );

  // Not a story: the reader is the subject, and it runs on the hosted model (receipts for
  // `atLeast`, `history`), which a story keeps to itself.
  it.live("reads through the reader, shaped as Domain reads a view", () =>
    Effect.gen(function* () {
      const accounts = yield* Account;
      yield* accounts.send(a1, new Deposit({ amount: 50, memo: "salary" }));
      yield* accounts.send(a1, new Withdraw({ amount: 20 }));
      const receipt = yield* accounts.send(b2, new Deposit({ amount: 5, memo: "gift" }));
      const ledger = yield* Ledger.Reader;
      // Wait for the write, then filter, order and page with Domain's own Filter and OrderBy.
      const deposits = yield* ledger.list({
        atLeast: receipt,
        where: { event: { _tag: "Deposited" } },
        orderBy: { key: "desc" },
      });
      expect(deposits.entries.map((row) => [row.key, row.event.amount])).toEqual([
        ["b2", 5],
        ["a1", 50],
      ]);
      expect(deposits.cursor).toBeNull();
      const firstPage = yield* ledger.list({ where: { key: "a1" }, take: 1 });
      const secondPage = yield* ledger.list({
        where: { key: "a1" },
        take: 1,
        after: firstPage.cursor ?? undefined,
      });
      expect([...firstPage.entries, ...secondPage.entries].map((row) => row.event._tag)).toEqual([
        "Deposited",
        "Withdrew",
      ]);
      expect(secondPage.cursor).toBeNull();
      // Rows decode: the event is the Domain event, times are DateTimes.
      const one = yield* ledger.get({
        key: "a1",
        stream: deposits.entries[1]!.envelope.stream,
        seq: 1,
      });
      expect(Option.map(one, (row) => row.event)).toEqual(
        Option.some(new Deposited({ amount: 50, memo: "salary" })),
      );
      expect((yield* ledger.history).complete).toBe(true);
      const lag = yield* ledger.lag({ where: { key: "a1" } });
      expect(lag.count).toBe(2);
      expect(lag.min).not.toBeNull();
    }).pipe(
      Effect.provide(
        Ledger.reader.pipe(
          Layer.provideMerge(Bank.layer(handlers)),
          Layer.provideMerge(Layer.mergeAll(InMemory, Lake.place(Ledger))),
          Layer.provideMerge(Lake.memory()),
        ),
      ),
      Effect.provide(RuntimeContext.phantom),
    ),
  );

  // Not a story: the retry sleeps inside the table's handler, and a story settles each handler
  // under its own clock before any step can move it.
  it.live("a run whose answer is lost is retried, and the store keeps each event once", () =>
    Effect.gen(function* () {
      const accounts = yield* Account;
      yield* accounts.send(a1, new Deposit({ amount: 1, memo: "first" }));
      // The first run's write lands, its answer is lost: the run fails and is handled again with the next.
      const receipt = yield* accounts.send(a1, new Deposit({ amount: 2, memo: "second" }));
      yield* Ledger.caughtUp(receipt);
      const rows = yield* raw;
      expect(rows.map((row) => row.event.amount).sort()).toEqual([1, 2]);
      expect(yield* Ref.get(yield* Writes)).toBeGreaterThan(1);
    }).pipe(
      Effect.provide(
        Bank.layer(
          Ledger.layer({ transient: "1 millis" }).pipe(Layer.provide(Lake.place(Ledger))),
        ).pipe(
          Layer.provideMerge(Layer.mergeAll(InMemory, Lake.place(Ledger))),
          Layer.provideMerge(Lake.toLayer(flaky)),
          Layer.provideMerge(Layer.effect(Writes, Ref.make(0))),
        ),
      ),
      Effect.provide(RuntimeContext.phantom),
    ),
  );

  it("sensitive event fields need a policy, and the policy shapes the spec", () => {
    expect(Cards.problems).toEqual([]);
    class Unprotected extends Export.Table(
      "Unprotected",
      { from: [Card], key: Card, on: [Opened] },
      { table: "unprotected" },
    ) {}
    // The mark sits on `owner.name`; the field protected is the whole top-level `owner`.
    expect(Unprotected.problems.map((problem) => problem._tag)).toEqual(["UnprotectedSensitive"]);
    expect(Cards.spec.events[0]!.columns.map((column) => column.path).sort()).toEqual([
      "event._tag",
      "event.limit",
    ]);
    expect(
      SealedCards.spec.events[0]!.columns.map((column) => [column.path, column.type._tag]).sort(),
    ).toEqual([
      ["event._tag", "Enum"],
      ["event.limit", "Int"],
      ["event.owner", "Bytes"],
    ]);
    // The policy is part of what the table means.
    expect(SealedCards.spec.fingerprint).not.toBe(Cards.spec.fingerprint);
  });

  it.effect("omit: a sensitive field never reaches the store", () =>
    Effect.gen(function* () {
      yield* Story.make(CardBook, { layer: cardHandlers })(
        Story.when(c1, new Open({ name: "alice", age: 30, limit: 5 })),
        Story.then(c1, new Opened({ owner: { name: "alice", age: 30 }, limit: 5 })),
      );
      const rows = yield* Stream.runCollect((yield* Cards.RawReader).scan({})).pipe(Effect.orDie);
      expect(JSON.stringify(rows)).not.toContain("alice");
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.toCodecJson(Cards.Read)),
      )(rows).pipe(Effect.orDie);
      expect(decoded.map((row) => [row.event._tag, row.event.limit, row.event.owner])).toEqual([
        ["Opened", 5, undefined],
      ]);
    }).pipe(Effect.provide(cardLake), Effect.provide(RuntimeContext.phantom)),
  );

  // Not a story: opening the field is the reader's work, on the hosted model (see above).
  it.live("encrypt: the store holds ciphertext, readers with the Sealer get the field back", () =>
    Effect.gen(function* () {
      const cards = yield* Card;
      const receipt = yield* cards.send(c1, new Open({ name: "alice", age: 30, limit: 5 }));
      // Read through the reader first: it waits for the write, and opens the field with the Sealer.
      const reader = yield* SealedCards.Reader;
      const page = yield* reader.list({ atLeast: receipt });
      expect(page.entries.map((row) => row.event.owner)).toEqual([{ name: "alice", age: 30 }]);
      // What the store holds is ciphertext.
      const rows = yield* Stream.runCollect((yield* SealedCards.RawReader).scan({})).pipe(
        Effect.orDie,
      );
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain("alice");
      expect(stored).toContain("sealed:");
    }).pipe(
      Effect.provide(
        SealedCards.reader.pipe(
          Layer.provideMerge(
            SealedCardBook.layer(
              SealedCards.layer().pipe(Layer.provide(SealedLake.place(SealedCards))),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(InMemory, SealedLake.place(SealedCards))),
          Layer.provideMerge(
            Layer.mergeAll(SealedLake.memory(), Layer.succeed(Export.Sensitive.Sealer, testSealer)),
          ),
        ),
      ),
      Effect.provide(RuntimeContext.phantom),
    ),
  );

  it("refuses metadata that redefines a built-in column", () => {
    class Redefined extends Export.Table(
      "Redefined",
      { from: [Account], key: Account, on: [Deposited] },
      {
        table: "redefined",
        metadata: { _export_lag_ms: Export.Metadata.copy("event.amount", Schema.Int) },
      },
    ) {}
    expect(Redefined.problems.map((problem) => problem._tag)).toEqual(["MetadataRedefined"]);
  });

  it("a version bump, a new metadata column, and the spec that changes with them", () => {
    class LedgerV1 extends Export.Table(
      "Ledger",
      { from: [Account], key: Account, on: [Deposited, Withdrew] },
      {
        table: "ledger",
        version: 1,
        metadata: {
          _export_memo: Export.Metadata.copy("event.memo", Schema.NullOr(Schema.String)),
          _export_amount: Export.Metadata.copy("event.amount", Schema.Int),
        },
      },
    ) {}
    expect(LedgerV1.spec.generation).toBe(1);
    expect(LedgerV1.spec.fingerprint).not.toBe(Ledger.spec.fingerprint);
    expect(LedgerV1.spec.metadata.map((m) => m.path).sort()).toEqual([
      "_export_amount",
      "_export_ingested_at",
      "_export_lag_ms",
      "_export_memo",
    ]);
  });

  it("a store refuses a changed table under the same generation", () => {
    class Changed extends Export.Table(
      "Ledger",
      { from: [Account], key: Account, on: [Deposited] },
      { table: "ledger" },
    ) {}
    const store = ExportStore.memory();
    const target = store.target(Ledger.spec);
    const exit = Effect.runSyncExit(
      Effect.andThen(target.ensure(Ledger.spec), target.ensure(Changed.spec)).pipe(
        Effect.provide(RuntimeContext.phantom),
      ),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("SchemaDrift");
  });

  it.effect("an event routed to two keys is two rows, one per key", () =>
    Effect.gen(function* () {
      yield* Story.make(Payments, { layer: transferHandlers })(
        Story.when(Payment.ref("p1"), new Send({ from: "a1", to: "b2", amount: 20 })),
        Story.then(Payment.ref("p1"), new Sent({ from: "a1", to: "b2", amount: 20 })),
      );
      const rows = yield* Stream.runCollect((yield* Transfers.RawReader).scan({})).pipe(
        Effect.orDie,
      );
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.toCodecJson(Transfers.Read)),
      )(rows).pipe(Effect.orDie);
      expect(decoded.map((row) => [row.key, row.event.amount]).sort()).toEqual([
        ["a1", 20],
        ["b2", 20],
      ]);
    }).pipe(Effect.provide(transferLake), Effect.provide(RuntimeContext.phantom)),
  );
});

// ---------------------------------------------------------------- a payment that lands on two accounts

class Sent extends Domain.Event("Sent", {
  from: Schema.String,
  to: Schema.String,
  amount: Schema.Int,
}) {}
class Send extends Domain.Command("Send", {
  target: Schema.String,
  input: { from: Schema.String, to: Schema.String, amount: Schema.Int },
  events: [Sent],
}) {}
class Payment extends Domain.Aggregate("Payment", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Send],
  decide: { Send: (_, { from, to, amount }) => [new Sent({ from, to, amount })] },
  evolve: { Sent: (s) => s },
}) {}
/** Each payment, once on the account it left and once on the account it reached. */
class Transfers extends Export.Table(
  "Transfers",
  {
    from: [Payment],
    key: Account,
    keyOf: {
      Sent: {
        out: ({ event }) => Account.ref(event.from),
        in: ({ event }) => Account.ref(event.to),
      },
    },
    on: [Sent],
  },
  { table: "transfers" },
) {}
class TransferLake extends Export.Store("TransferLake", { tables: [Transfers] }) {}
class Payments extends Domain.Model("Payments", {
  aggregates: [Account, Payment],
  projections: [Transfers],
}) {}
const transferHandlers = Transfers.layer().pipe(Layer.provide(TransferLake.place(Transfers)));
const transferLake = TransferLake.place(Transfers).pipe(Layer.provideMerge(TransferLake.memory()));

// ---------------------------------------------------------------- cards with a sensitive owner

class Opened extends Domain.Event("Opened", {
  owner: Schema.Struct({ name: Schema.String.annotate({ sensitive: true }), age: Schema.Int }),
  limit: Schema.Int,
}) {}
class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { name: Schema.String, age: Schema.Int, limit: Schema.Int },
  events: [Opened],
}) {}
class Card extends Domain.Aggregate("Card", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Open],
  decide: { Open: (_, { name, age, limit }) => [new Opened({ owner: { name, age }, limit })] },
  evolve: { Opened: (s) => s },
}) {}

class Cards extends Export.Table(
  "Cards",
  { from: [Card], key: Card, on: [Opened] },
  { table: "cards", sensitive: "omit" },
) {}
class SealedCards extends Export.Table(
  "SealedCards",
  { from: [Card], key: Card, on: [Opened] },
  { table: "sealed_cards", sensitive: "encrypt" },
) {}
class CardLake extends Export.Store("CardLake", { tables: [Cards] }) {}
class SealedLake extends Export.Store("SealedLake", { tables: [SealedCards] }) {}
class CardBook extends Domain.Model("CardBook", { aggregates: [Card], projections: [Cards] }) {}
class SealedCardBook extends Domain.Model("SealedCardBook", {
  aggregates: [Card],
  projections: [SealedCards],
}) {}

const c1 = Card.ref("c1");
const cardHandlers = Cards.layer().pipe(Layer.provide(CardLake.place(Cards)));
const cardLake = CardLake.place(Cards).pipe(Layer.provideMerge(CardLake.memory()));

/** A reversible stand-in for a key holder: enough to tell ciphertext from plaintext. */
const testSealer: Export.Sensitive.Sealer["Service"] = {
  seal: (plaintext) => Effect.succeed(`sealed:${Buffer.from(plaintext).toString("base64")}`),
  open: (ciphertext) =>
    ciphertext.startsWith("sealed:")
      ? Effect.succeed(Buffer.from(ciphertext.slice("sealed:".length), "base64").toString())
      : Effect.fail(new Export.Sensitive.SealFailed({ reason: "not sealed by this sealer" })),
};

// ---------------------------------------------------------------- a store whose first answer is lost

/** How many writes reached the flaky store. */
class Writes extends Context.Service<Writes, Ref.Ref<number>>()("Test/Export/Writes") {}

const flaky = Effect.gen(function* () {
  const writes = yield* Writes;
  const memory = ExportStore.memory();
  return {
    reader: memory.reader,
    target: (spec) => {
      const target = memory.target(spec);
      return {
        ...target,
        write: (s, run) =>
          target.write(s, run).pipe(
            Effect.andThen(Ref.getAndUpdate(writes, (n) => n + 1)),
            Effect.flatMap((n) =>
              n === 0
                ? Effect.fail(
                    new ExportStore.Unavailable({
                      store: "flaky",
                      operation: "write",
                      reason: "answer lost",
                    }),
                  )
                : Effect.void,
            ),
          ),
      };
    },
  } satisfies ExportStore.Implementation;
});
