import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { definitionProblems } from "./definition-problems.ts";

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Deposit extends Domain.Command("Deposit", {
  input: { id: Schema.String, amount: Schema.Number },
  events: [Deposited],
}) {}
class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit],
  keyOf: (command) => command.id,
  decide: { Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

class Sent extends Domain.Event("Sent", { to: Schema.String, amount: Schema.Number }) {}
class Send extends Domain.Command("Send", {
  input: { id: Schema.String, to: Schema.String, amount: Schema.Number },
  events: [Sent],
}) {}
class Payment extends Domain.Aggregate("Payment", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Send],
  keyOf: (command) => command.id,
  decide: { Send: (_, { to, amount }) => [new Sent({ to, amount })] },
  evolve: { Sent: (s) => s },
}) {}

class Balance extends Domain.View("Balance", {
  from: [Wallet],
  key: Wallet,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

class Card extends Domain.Event("Card", { amount: Schema.Number }) {}
class WalletCard extends Domain.Stream("WalletCard", { key: Wallet, entries: [Card] }) {}
class WalletCards extends Domain.Projection("WalletCards", {
  from: [Wallet],
  key: Wallet,
  on: [Deposited],
  writes: [WalletCard],
}) {}

const noop = Effect.succeed(() => Effect.void);
const WalletCardsLive = WalletCards.toLayer(noop);

class Bank extends Domain.Model("Bank", {
  aggregates: [Wallet, Payment],
  views: [Balance],
  projections: [WalletCards],
  streams: [WalletCard],
}) {}

// Payments are keyed by payment id, not by wallet: routing them needs keyOf.
class Received extends Domain.View("Received", {
  from: [Payment],
  key: Wallet,
  state: Schema.Struct({ total: Schema.Number }),
  evolve: { Sent: (s, e) => ({ total: (s?.total ?? 0) + e.amount }) },
}) {}
// Keyed by a branch id rather than an aggregate: a wallet's events name no branch.
const BranchId = Schema.String.pipe(Schema.brand("BranchId"));
class BranchTotals extends Domain.View("BranchTotals", {
  from: [Wallet],
  key: BranchId,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Deposited: (s, e) => ({ total: s.total + e.amount }) },
}) {}
// Keyed by branch id, so it cannot write a stream keyed by wallet.
class BranchCard extends Domain.Stream("BranchCard", { key: Wallet, entries: [Card] }) {}
class BranchCards extends Domain.Projection("BranchCards", {
  from: [Wallet],
  key: BranchId,
  keyOf: { Deposited: () => BranchId.make("main") },
  on: [Deposited],
  writes: [BranchCard],
}) {}
class AlsoCards extends Domain.Projection("AlsoCards", {
  from: [Wallet],
  key: Wallet,
  on: [Deposited],
  writes: [WalletCard],
}) {}
class Broken extends Domain.Model("Broken", {
  aggregates: [Wallet, Payment],
  views: [Received, BranchTotals],
  projections: [WalletCards, AlsoCards, BranchCards],
  streams: [WalletCard, BranchCard],
}) {}

// Notify listens for an event its source never emits, and Audit reads a view
// the model does not host. Ledger's initial state does not fit its schema.
class Notify extends Domain.Policy("Notify", { from: Payment, on: [Deposited] }) {}
class Audit extends Domain.Policy("Audit", { from: Balance, on: [Deposited] }) {}
class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ entries: Schema.Number }),
  initial: { entries: "none" } as unknown as { entries: number },
  commands: [],
  decide: {},
  evolve: {},
}) {}
class AlsoBroken extends Domain.Model("AlsoBroken", {
  aggregates: [Wallet, Payment, Ledger],
  policies: [Notify, Audit],
}) {}

const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
const CustomerId = Schema.String.pipe(Schema.brand("CustomerId"));
class Opened extends Domain.Event("Opened") {}
class OpenAccount extends Domain.Command("OpenAccount", {
  input: { accountId: AccountId },
  events: [Opened],
}) {}
// Addresses a customer, so it does not belong on Account.
class OpenForCustomer extends Domain.Command("OpenForCustomer", {
  input: { customerId: CustomerId },
  events: [Opened],
}) {}
// A plain string target accepts ids that are not an AccountId.
class OpenAny extends Domain.Command("OpenAny", {
  input: { id: Schema.String },
  events: [Opened],
}) {}

describe("Domain definition problems", { tags: ["unit", "local"] }, () => {
  it("finds no problem in a correct model", () =>
    Effect.gen(function* () {
      expect(yield* definitionProblems(Bank.layer(WalletCardsLive))).toEqual([]);
    }).pipe(Effect.runPromise));

  it("the Layer dies with every definition problem at once", () =>
    Effect.gen(function* () {
      const layer = Broken.layer(
        Layer.mergeAll(WalletCardsLive, AlsoCards.toLayer(noop), BranchCards.toLayer(noop)),
      );
      expect(yield* definitionProblems(layer)).toMatchObject([
        { _tag: "DefinitionError", message: "Received declares state without initial" },
        {
          message:
            "Received consumes 'Sent' from Payment, which is not keyed by Wallet: add keyOf.Sent",
        },
        {
          message:
            "BranchTotals consumes 'Deposited' from Wallet, which is not keyed by its key schema: add keyOf.Deposited",
        },
        {
          message:
            "WalletCard has two writers, WalletCards and AlsoCards: a stream key has exactly one",
        },
        {
          message:
            "Projection BranchCards is keyed by a key schema, so it cannot write BranchCard, keyed by Wallet",
        },
      ]);
    }).pipe(Effect.runPromise));

  it("goes on past a problem to find the next one", () =>
    Effect.gen(function* () {
      const layer = AlsoBroken.layer(Layer.mergeAll(Notify.toLayer(noop), Audit.toLayer(noop)));
      expect(yield* definitionProblems(layer)).toMatchObject([
        { message: expect.stringContaining("Ledger.initial does not match its state schema") },
        { message: "Policy Notify: none of Payment emits 'Deposited'" },
        { message: "Policy Audit consumes Balance, which is not in the Domain" },
      ]);
    }).pipe(Effect.runPromise));

  describe("aggregate keyOf", { tags: ["unit", "local"] }, () => {
    it("a command addresses its aggregate's id", () => {
      class Account extends Domain.Aggregate("Account", {
        id: AccountId,
        state: Schema.Struct({}),
        initial: {},
        commands: [OpenAccount],
        keyOf: (command) => command.accountId,
        decide: { OpenAccount: () => [new Opened()] },
        evolve: { Opened: (s) => s },
      }) {}
      expect(Account.ref("a-1").id).toBe("a-1");
    });

    it("a keyOf that returns another id schema is a type error", () => {
      class Account extends Domain.Aggregate("Account", {
        id: AccountId,
        state: Schema.Struct({}),
        initial: {},
        commands: [OpenAccount, OpenForCustomer],
        // @ts-expect-error a CustomerId is not this aggregate's id
        keyOf: (command) => ("accountId" in command ? command.accountId : command.customerId),
        decide: {
          OpenAccount: () => [new Opened()],
          OpenForCustomer: () => [new Opened()],
        },
        evolve: { Opened: (s) => s },
      }) {}
      expect(Account.aggregateName).toBe("Account");
    });

    it("a keyOf that returns a wider type than the id is a type error", () => {
      class Account extends Domain.Aggregate("Account", {
        id: AccountId,
        state: Schema.Struct({}),
        initial: {},
        commands: [OpenAny],
        // @ts-expect-error a plain string is not this aggregate's id
        keyOf: (command) => command.id,
        decide: { OpenAny: () => [new Opened()] },
        evolve: { Opened: (s) => s },
      }) {}
      expect(Account.aggregateName).toBe("Account");
    });
  });
});

class Blob {
  constructor(readonly bytes: number) {}
}
/** A schema with no JSON form: its values fail when they are encoded. */
const NoJson = Schema.instanceOf(Blob);
const messageOf = (problem: unknown) =>
  Predicate.hasProperty(problem, "message") ? problem.message : problem;
const noJsonForm = (path: string) =>
  `${path} has no JSON form: use a Schema with one, or annotate it with toCodecJson`;

class Tagged extends Domain.Rejection("Tagged", { blob: NoJson }) {}
class Stored extends Domain.Event("Stored", { blob: NoJson }) {}
class Store extends Domain.Command("Store", {
  input: { shelf: Schema.String, blobs: Schema.Array(NoJson) },
  events: [Stored],
  rejects: [Tagged],
  reply: { blob: NoJson },
}) {}
class Shelf extends Domain.Aggregate("Shelf", {
  id: Schema.String,
  state: Schema.Struct({
    slot: Schema.Option(NoJson),
    bySku: Schema.Record(Schema.String, NoJson),
    spare: Schema.optional(NoJson),
    pair: Schema.Tuple([Schema.String, Schema.Array(NoJson)]),
    either: Schema.Union([Schema.Number, NoJson]),
  }),
  initial: { slot: Option.none(), bySku: {}, pair: ["a", []], either: 0 },
  commands: [Store],
  keyOf: (command) => command.shelf,
  decide: { Store: () => [] },
  evolve: { Stored: (s) => s },
  reply: { Store: () => ({ blob: new Blob(1) }) },
}) {}
class Shelves extends Domain.Model("Shelves", { aggregates: [Shelf] }) {}

describe("Domain definition problems on JSON", { tags: ["unit", "local"] }, () => {
  it("reports each schema with no JSON form, by path", () =>
    Effect.gen(function* () {
      const problems = yield* definitionProblems(Shelves.layer(Layer.empty));
      expect(problems.map(messageOf)).toEqual([
        noJsonForm("Event Stored.blob"),
        noJsonForm("Shelf.state.slot"),
        noJsonForm("Shelf.state.bySku[key]"),
        noJsonForm("Shelf.state.spare"),
        noJsonForm("Shelf.state.pair[1][]"),
        noJsonForm("Shelf.state.either"),
        noJsonForm("Command Store.blobs[]"),
        noJsonForm("Command Store.reply.blob"),
        noJsonForm("Rejection Tagged.blob"),
      ]);
    }).pipe(Effect.runPromise));

  it("gives each problem a tagged reason with its path", () =>
    Effect.gen(function* () {
      const [first] = yield* definitionProblems(Shelves.layer(Layer.empty));
      expect(first).toMatchObject({
        _tag: "DefinitionError",
        reason: { _tag: "NoJsonForm", path: "Event Stored.blob" },
      });
    }).pipe(Effect.runPromise));

  it("reports a decision's command, reply and rejection", () =>
    Effect.gen(function* () {
      class Moved extends Domain.Event("Moved") {}
      class Lost extends Domain.Rejection("Lost", { blob: NoJson }) {}
      class Move extends Domain.Command("Move", {
        input: { from: Schema.String, to: Schema.String, blob: NoJson },
        events: [Moved],
        rejects: [Lost],
        reply: { blob: NoJson },
      }) {}
      class Bin extends Domain.Aggregate("Bin", {
        id: Schema.String,
        state: Schema.Struct({}),
        initial: {},
        commands: [],
        events: [Moved],
        decide: {},
        evolve: { Moved: (s) => s },
      }) {}
      class MoveBlob extends Domain.Decision(Move, {
        reads: { from: Bin, to: Bin },
        keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
        decide: ({ from }) => [from.record(new Moved())],
        reply: () => ({ blob: new Blob(1) }),
      }) {}
      class Bins extends Domain.Model("Bins", { aggregates: [Bin], decisions: [MoveBlob] }) {}
      expect((yield* definitionProblems(Bins.layer(Layer.empty))).map(messageOf)).toEqual([
        noJsonForm("Command Move.blob"),
        noJsonForm("Command Move.reply.blob"),
        noJsonForm("Rejection Lost.blob"),
      ]);
    }).pipe(Effect.runPromise));

  it("reports a view's state and events and a stream's entries", () =>
    Effect.gen(function* () {
      class Seen extends Domain.Event("Seen", { blob: NoJson }) {}
      class Shown extends Domain.View("Shown", {
        from: [Wallet],
        key: Wallet,
        state: Schema.Struct({ last: Schema.NullOr(NoJson) }),
        initial: { last: null },
        events: [Seen],
        evolve: { Deposited: (s) => s },
      }) {}
      class Snap extends Domain.Event("Snap", { blob: NoJson }) {}
      class Snaps extends Domain.Stream("Snaps", { key: Wallet, entries: [Snap] }) {}
      class Snapper extends Domain.Projection("Snapper", {
        from: [Wallet],
        key: Wallet,
        on: [Deposited],
        writes: [Snaps],
      }) {}
      class Viewed extends Domain.Model("Viewed", {
        aggregates: [Wallet],
        views: [Shown],
        projections: [Snapper],
        streams: [Snaps],
      }) {}
      expect(
        (yield* definitionProblems(Viewed.layer(Snapper.toLayer(noop)))).map(messageOf),
      ).toEqual([
        noJsonForm("Event Seen.blob"),
        noJsonForm("Event Snap.blob"),
        noJsonForm("Shown.state.last"),
      ]);
    }).pipe(Effect.runPromise));

  it("reports an initial state that does not survive JSON", () =>
    Effect.gen(function* () {
      const Loose = Schema.Struct({ value: Schema.Any });
      class Lossy extends Domain.Aggregate("Lossy", {
        id: Schema.String,
        state: Loose,
        initial: { value: () => 1 },
        commands: [],
        decide: {},
        evolve: {},
      }) {}
      class Big extends Domain.View("Big", {
        from: [Wallet],
        key: Wallet,
        state: Loose,
        initial: { value: 1n },
        evolve: { Deposited: (s) => s },
      }) {}
      class Lossless extends Domain.Model("Lossless", {
        aggregates: [Wallet, Lossy],
        views: [Big],
      }) {}
      expect(yield* definitionProblems(Lossless.layer(Layer.empty))).toMatchObject([
        { reason: { _tag: "InitialNotJson", owner: "Lossy" } },
        { reason: { _tag: "InitialNotJson", owner: "Big" } },
      ]);
    }).pipe(Effect.runPromise));

  it("reports a view's initial that does not match its state", () =>
    Effect.gen(function* () {
      class Counted extends Domain.View("Counted", {
        from: [Wallet],
        key: Wallet,
        state: Schema.Struct({ count: Schema.Number }),
        initial: Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Any }))({ count: "none" }),
        evolve: { Deposited: (s) => s },
      }) {}
      class Counts extends Domain.Model("Counts", { aggregates: [Wallet], views: [Counted] }) {}
      expect((yield* definitionProblems(Counts.layer(Layer.empty))).map(messageOf)).toEqual([
        expect.stringContaining("Counted.initial does not match its state schema"),
      ]);
    }).pipe(Effect.runPromise));

  it("passes every schema with a JSON form", () =>
    Effect.gen(function* () {
      interface Tree {
        readonly kids: ReadonlyArray<Tree>;
      }
      const Tree: Schema.Codec<Tree> = Schema.Struct({
        kids: Schema.Array(Schema.suspend(() => Tree)),
      });
      const Annotated = Schema.instanceOf(Blob, {
        toCodecJson: () =>
          Schema.link<Blob>()(Schema.Number, {
            decode: SchemaGetter.transform((bytes: number) => new Blob(bytes)),
            encode: SchemaGetter.transform((blob: Blob) => blob.bytes),
          }),
      });
      class Fine extends Domain.Aggregate("Fine", {
        id: Schema.String,
        state: Schema.Struct({
          anything: Schema.Unknown,
          at: Schema.Date,
          when: Schema.DateTimeUtc,
          big: Schema.BigInt,
          secret: Schema.Redacted(Schema.String),
          maybe: Schema.Option(Schema.Number),
          bytes: Schema.Uint8Array,
          counts: Schema.ReadonlyMap(Schema.String, Schema.Number),
          tree: Tree,
          blob: Annotated,
        }),
        initial: {
          anything: { a: 1 },
          at: new Date(0),
          when: DateTime.makeUnsafe(0),
          big: 1n,
          secret: Redacted.make("s"),
          maybe: Option.some(1),
          bytes: new Uint8Array([1]),
          counts: new Map([["a", 1]]),
          tree: { kids: [{ kids: [] }] },
          blob: new Blob(1),
        },
        commands: [],
        decide: {},
        evolve: {},
      }) {}
      class FineModel extends Domain.Model("FineModel", { aggregates: [Fine] }) {}
      expect(yield* definitionProblems(FineModel.layer(Layer.empty))).toEqual([]);
    }).pipe(Effect.runPromise));
});
