import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import * as Memory from "@alchemy.run/domain/InMemory";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Internals } from "@alchemy.run/domain/Model";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Decisions from "./decision-model.ts";
import { type Disk, simHost } from "./sim-host.ts";

// ---------------------------------------------------------------- customers and their accounts

class Registered extends Domain.Event("Registered", { name: Schema.String }) {}
class Register extends Domain.Command("Register", {
  input: { id: Schema.String, name: Schema.String },
  events: [Registered],
}) {}
class Customer extends Domain.Aggregate("Customer", {
  id: Schema.String,
  state: Schema.Struct({ name: Schema.String }),
  initial: { name: "" },
  commands: [Register],
  keyOf: (command) => command.id,
  decide: { Register: (_, { name }) => [new Registered({ name })] },
  evolve: { Registered: (_, e) => ({ name: e.name }) },
}) {}

class Opened extends Domain.Event("Opened", { customerId: Schema.String, owner: Schema.String }) {}
class Deposited extends Domain.Event("Deposited", {
  amount: Schema.Number,
  balance: Schema.Number,
}) {}
class Noted extends Domain.Event("Noted", { text: Schema.String }) {}
const AccountState = Schema.Struct({
  customerId: Schema.String,
  owner: Schema.String,
  balance: Schema.Number,
  notes: Schema.Number,
});
class BroughtForward extends Domain.Event("BroughtForward", { state: AccountState }) {}

class Open extends Domain.Command("Open", {
  input: { id: Schema.String, customerId: Schema.String, owner: Schema.String },
  events: [Opened],
}) {}
class Deposit extends Domain.Command("Deposit", {
  input: { id: Schema.String, amount: Schema.Number },
  events: [Deposited],
  reply: { balance: Schema.Number },
}) {}
class Note extends Domain.Command("Note", {
  input: { id: Schema.String, text: Schema.String },
  events: [Noted],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: AccountState,
  initial: { customerId: "", owner: "", balance: 0, notes: 0 },
  invariants: { neverOverdrawn: (account) => account.balance >= 0 },
  commands: [Open, Deposit, Note],
  events: [BroughtForward],
  keyOf: (command) => command.id,
  decide: {
    Open: (_, { customerId, owner }) => [new Opened({ customerId, owner })],
    Deposit: (account, { amount }) => [
      new Deposited({ amount, balance: account.balance + amount }),
    ],
    Note: (_, { text }) => [new Noted({ text })],
  },
  evolve: {
    Opened: (account, e) => ({ ...account, customerId: e.customerId, owner: e.owner }),
    Deposited: (account, e) => ({ ...account, balance: e.balance }),
    Noted: (account) => ({ ...account, notes: account.notes + 1 }),
    BroughtForward: (_, e) => e.state,
  },
  reply: { Deposit: (account) => ({ balance: account.balance }) },
}) {}

/** One account: keyed by its aggregate. */
class Summary extends Domain.View("Summary", {
  from: [Account],
  key: Account,
  state: Schema.Struct({
    customerId: Schema.String,
    owner: Schema.String,
    balance: Schema.Number,
  }),
  initial: { customerId: "", owner: "", balance: 0 },
  evolve: {
    Opened: (summary, e) => ({ ...summary, customerId: e.customerId, owner: e.owner }),
    Deposited: (summary, e) => ({ ...summary, balance: e.balance }),
    BroughtForward: (_, e) => ({
      customerId: e.state.customerId,
      owner: e.state.owner,
      balance: e.state.balance,
    }),
  },
}) {}

/** A customer's accounts: fed by the customer and by every one of their accounts' summaries. */
class Dashboard extends Domain.View("Dashboard", {
  from: [Customer, Summary],
  key: Customer,
  keyOf: {
    Summary: ({ state }) => (state?.customerId ? Customer.ref(state.customerId) : undefined),
  },
  state: Schema.Struct({
    name: Schema.String,
    owners: Schema.Record(Schema.String, Schema.String),
    balances: Schema.Record(Schema.String, Schema.Number),
  }),
  initial: { name: "", owners: {}, balances: {} },
  evolve: {
    Registered: (dashboard, e) => ({ ...dashboard, name: e.name }),
    Summary: (dashboard, _, { source, state }) => ({
      ...dashboard,
      owners: { ...dashboard.owners, [source.id]: state?.owner ?? "" },
      balances: { ...dashboard.balances, [source.id]: state?.balance ?? 0 },
    }),
  },
}) {}

/** Every account at once: one key, fed by many instances. */
class Ledger extends Domain.View("Ledger", {
  from: [Account],
  key: Schema.String,
  keyOf: { Account: () => "all" },
  state: Schema.Struct({
    total: Schema.Number,
    notes: Schema.Number,
    owners: Schema.Record(Schema.String, Schema.String),
  }),
  initial: { total: 0, notes: 0, owners: {} },
  evolve: {
    Opened: (ledger, e, { source }) => ({
      ...ledger,
      owners: { ...ledger.owners, [source.id]: e.owner },
    }),
    Deposited: (ledger, e) => ({ ...ledger, total: ledger.total + e.amount }),
    Noted: (ledger) => ({ ...ledger, notes: ledger.notes + 1 }),
    // What the events it replaces added: a key that holds them never folds it.
    BroughtForward: (ledger, e, { source }) => ({
      total: ledger.total + e.state.balance,
      notes: ledger.notes + e.state.notes,
      owners: { ...ledger.owners, [source.id]: e.state.owner },
    }),
  },
}) {}

/** A customer's accounts, read from the accounts themselves: an event's own field picks the key. */
class Holders extends Domain.View("Holders", {
  from: [Account],
  key: Customer,
  keyOf: {
    Opened: ({ event }) => Customer.ref(event.customerId),
    BroughtForward: ({ event }) => Customer.ref(event.state.customerId),
  },
  state: Schema.Struct({ owners: Schema.Record(Schema.String, Schema.String) }),
  initial: { owners: {} },
  evolve: {
    Opened: (holders, e, { source }) => ({ owners: { ...holders.owners, [source.id]: e.owner } }),
    BroughtForward: (holders, e, { source }) => ({
      owners: { ...holders.owners, [source.id]: e.state.owner },
    }),
  },
}) {}

// ---------------------------------------------------------------- stores outside the model

interface Rewrote {
  readonly projection: string;
  readonly key: string;
  readonly before: unknown;
  readonly after: unknown;
}

class Tables extends Context.Service<
  Tables,
  {
    readonly directory: Ref.Ref<ReadonlyMap<string, string>>;
    readonly owners: Ref.Ref<ReadonlyMap<string, string>>;
    readonly rewrote: Ref.Ref<ReadonlyArray<Rewrote>>;
    readonly archived: Ref.Ref<
      ReadonlyArray<{ readonly stream: string; readonly seqs: ReadonlyArray<number> }>
    >;
  }
>()("Test/Tables") {}

const TablesLive = Layer.effect(
  Tables,
  Effect.all({
    directory: Ref.make<ReadonlyMap<string, string>>(new Map()),
    owners: Ref.make<ReadonlyMap<string, string>>(new Map()),
    rewrote: Ref.make<ReadonlyArray<Rewrote>>([]),
    archived: Ref.make<
      ReadonlyArray<{ readonly stream: string; readonly seqs: ReadonlyArray<number> }>
    >([]),
  }),
);

const set = (table: Ref.Ref<ReadonlyMap<string, string>>, key: string, value: string) =>
  Ref.update(table, (map) => new Map(map).set(key, value));
const remove = (table: Ref.Ref<ReadonlyMap<string, string>>, key: string) =>
  Ref.update(table, (map) => {
    const next = new Map(map);
    next.delete(key);
    return next;
  });

/** Customers by name, fed by the aggregate. */
class Directory extends Domain.Projection("Directory", {
  from: [Customer],
  key: Customer,
  on: [Registered],
}) {}
const DirectoryLive = Directory.toLayer(
  Effect.gen(function* () {
    const tables = yield* Tables;
    return {
      write: Effect.fn(function* (batch) {
        for (const { key, event } of batch) yield* set(tables.directory, key.id, event.name);
      }),
      rewrite: Effect.fn(function* (batch) {
        for (const { key, before, after } of batch) {
          yield* Ref.update(tables.rewrote, (all) => [
            ...all,
            { projection: "Directory", key: key.id, before, after },
          ]);
          if (after === undefined) yield* remove(tables.directory, key.id);
          else yield* set(tables.directory, key.id, after.name);
        }
      }),
    };
  }),
);

/** Each account's owner, fed by the account's view. */
class Owners extends Domain.Projection("Owners", {
  from: [Summary],
  key: Account,
  on: [Opened],
}) {}
const OwnersLive = Owners.toLayer(
  Effect.gen(function* () {
    const tables = yield* Tables;
    return {
      write: Effect.fn(function* (batch) {
        for (const { key, event } of batch) yield* set(tables.owners, key.id, event.owner);
      }),
      rewrite: Effect.fn(function* (batch) {
        for (const { key, before, after } of batch) {
          yield* Ref.update(tables.rewrote, (all) => [
            ...all,
            { projection: "Owners", key: key.id, before, after },
          ]);
          if (after === undefined) yield* remove(tables.owners, key.id);
          else yield* set(tables.owners, key.id, after.owner);
        }
      }),
    };
  }),
);

/** Each account as a card, in a stream the model keeps: what its projection appends. */
class CardChanged extends Domain.Event("CardChanged", {
  owner: Schema.String,
  balance: Schema.Number,
}) {}
class Card extends Domain.Stream("Card", { key: Account, entries: [CardChanged] }) {}
class Cards extends Domain.Projection("Cards", {
  from: [Summary],
  key: Account,
  on: [Opened, Deposited],
  writes: [Card],
}) {}
const CardsLive = Cards.toLayer(
  Effect.gen(function* () {
    const cards = yield* Card;
    return {
      write: Effect.fn(function* (batch) {
        for (const input of batch) {
          if (input.state === null) continue;
          yield* cards.append(
            input,
            new CardChanged({ owner: input.state.owner, balance: input.state.balance }),
          );
        }
      }),
      rewrite: Effect.fn(function* (batch) {
        for (const input of batch) {
          // No card for an event that is gone; the card as the account now reads otherwise.
          if (input.after === undefined || !input.state) yield* cards.rewrite(input);
          else {
            yield* cards.rewrite(
              input,
              new CardChanged({ owner: input.state.owner, balance: input.state.balance }),
            );
          }
        }
      }),
    };
  }),
);

/** A key's cards, as `[seq, owner, balance]`. */
const cardsOf = (id: string) =>
  Effect.gen(function* () {
    const page = yield* (yield* Card).list(Account.ref(id));
    return page.entries.map(
      (entry) => [entry.envelope.seq, entry.event.owner, entry.event.balance] as const,
    );
  });

// ---------------------------------------------------------------- rewrites and a compaction

/** Removes a customer's name from an account they opened, and every note on it. */
class ForgetOwner extends Domain.Rewrite("ForgetOwner", {
  of: Account,
  input: { customerId: Schema.String },
  events: {
    Opened: (event, { customerId }) =>
      event.customerId === customerId ? new Opened({ ...event, owner: "" }) : event,
    Noted: () => null,
  },
}) {}

/** The same, for an account that has compacted: its roll-up holds the name and counts the notes. */
class ForgetOwnerForGood extends Domain.Rewrite("ForgetOwnerForGood", {
  of: Account,
  events: {
    Opened: (event) => new Opened({ ...event, owner: "" }),
    Noted: () => null,
    BroughtForward: (event) =>
      new BroughtForward({ state: { ...event.state, owner: "", notes: 0 } }),
  },
}) {}

/** Undoes every event an account recorded after `since`, as a restore to that point would. */
const undo = <E>(
  event: E,
  { since }: { readonly since: number },
  { seq }: { readonly seq: number },
) => (seq > since ? null : event);
class UndoSince extends Domain.Rewrite("UndoSince", {
  of: Account,
  input: { since: Schema.Number },
  events: { Opened: undo, Deposited: undo, Noted: undo, BroughtForward: undo },
}) {}

class DeleteCustomer extends Domain.Rewrite("DeleteCustomer", { of: Customer, delete: true }) {}
class DeleteAccount extends Domain.Rewrite("DeleteAccount", { of: Account, delete: true }) {}

/** Moves an account to another customer, as if it had always been theirs. */
class Reassign extends Domain.Rewrite("Reassign", {
  of: Account,
  input: { to: Schema.String },
  events: {
    Opened: (event, { to }) => new Opened({ ...event, customerId: to }),
    BroughtForward: (event, { to }) =>
      new BroughtForward({ state: { ...event.state, customerId: to } }),
  },
}) {}

/** Breaks the account's invariant: nothing may change. */
class Overdraw extends Domain.Rewrite("Overdraw", {
  of: Account,
  events: { Deposited: (event) => new Deposited({ ...event, balance: -1 }) },
}) {}

class BringForward extends Domain.Compaction("BringForward", {
  of: Account,
  rollup: (account) => [new BroughtForward({ state: account })],
}) {}

/** Loses the account: nothing may change. */
class Forget extends Domain.Compaction("Forget", { of: Account, rollup: () => [] }) {}

const archive = (
  compaction: typeof BringForward | typeof Forget,
  options?: Domain.Compaction.Options,
) =>
  compaction.toLayer(
    Effect.gen(function* () {
      const tables = yield* Tables;
      return Effect.fn(function* ({ stream, events }) {
        yield* Ref.update(tables.archived, (all) => [
          ...all,
          { stream, seqs: events.map(({ envelope }) => envelope.seq) },
        ]);
      });
    }),
    options,
  );

class Bank extends Domain.Model("Bank", {
  aggregates: [Customer, Account],
  views: [Summary, Dashboard, Ledger, Holders],
  projections: [Directory, Owners, Cards],
  streams: [Card],
  rewrites: [
    ForgetOwner,
    ForgetOwnerForGood,
    DeleteCustomer,
    DeleteAccount,
    Reassign,
    Overdraw,
    UndoSince,
  ],
  compactions: [BringForward, Forget],
}) {}

const handlers = (after?: number) =>
  Layer.mergeAll(
    DirectoryLive,
    OwnersLive,
    CardsLive,
    archive(BringForward, after === undefined ? {} : { after: { events: after } }),
    archive(Forget),
  );

const onDurableObjects = (disk?: Disk) =>
  DurableObjects.makePlatform(simHost({ rowsRead: 0 }, disk ? { disk } : {}).host).pipe(
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );

const platforms = {
  "in memory": () => InMemory,
  "Durable Objects": () => onDurableObjects(),
} as const;

const bankOn = (platform: keyof typeof platforms, after?: number) =>
  Bank.layer(handlers(after)).pipe(
    Layer.provideMerge(TablesLive),
    Layer.provideMerge(platforms[platform]()),
  );

/** The stored events of an account, as `[seq, tag]`. */
const stored = (aggregate: string, id: string) =>
  Effect.gen(function* () {
    const { aggregates } = yield* Internals;
    const events = yield* aggregates.get(aggregate)!.events!(id);
    return events.map(
      (row) => [row.envelope.seq, (row.event as { readonly _tag: string })._tag] as const,
    );
  });

/** Sam, with one account that has a deposit and two notes, read by every view and projection. */
const seeded = Effect.gen(function* () {
  const customers = yield* Customer;
  const accounts = yield* Account;
  yield* customers.send(new Register({ id: "c-1", name: "Sam" }));
  const opened = yield* accounts.send(new Open({ id: "a-1", customerId: "c-1", owner: "Sam" }));
  yield* accounts.send(new Note({ id: "a-1", text: "call Sam back" }));
  const deposited = yield* accounts.send(new Deposit({ id: "a-1", amount: 100 }));
  yield* accounts.send(new Note({ id: "a-1", text: "Sam's birthday" }));
  const atLeast = { stream: deposited.stream, version: deposited.version };
  yield* (yield* Summary).get(Account.ref("a-1"), { atLeast });
  yield* Owners.caughtUp(opened);
  yield* Cards.caughtUp(deposited);
  const dashboards = yield* Dashboard;
  yield* dashboards.waitFor(Customer.ref("c-1"), { balances: { "a-1": 100 } } as never, {
    timeout: "10 seconds",
  });
  return { customers, accounts, dashboards };
});

for (const platform of Object.keys(platforms) as ReadonlyArray<keyof typeof platforms>) {
  describe(`Domain rewrites, ${platform}`, { tags: ["unit", "local"] }, () => {
    it.live(
      "a rewrite changes the events, the state, every view and every projection",
      () =>
        Effect.gen(function* () {
          const { accounts, dashboards } = yield* seeded;
          const tables = yield* Tables;
          expect((yield* Ref.get(tables.owners)).get("a-1")).toBe("Sam");

          const receipt = yield* accounts.rewrite("a-1", new ForgetOwner({ customerId: "c-1" }));
          expect(receipt).toMatchObject({ stream: "Account/a-1", changed: 3 });
          yield* accounts.rewritten(receipt);

          // The notes are gone and leave gaps: sequence numbers never change.
          expect(yield* stored("Account", "a-1")).toEqual([
            [1, "Opened"],
            [3, "Deposited"],
          ]);
          expect(yield* accounts.get("a-1")).toEqual({
            customerId: "c-1",
            owner: "",
            balance: 100,
            notes: 0,
          });
          expect(Option.getOrNull(yield* (yield* Summary).get(Account.ref("a-1")))).toEqual({
            customerId: "c-1",
            owner: "",
            balance: 100,
          });
          // Through the summary, into the view keyed by the customer.
          expect(Option.getOrNull(yield* dashboards.get(Customer.ref("c-1")))).toEqual({
            name: "Sam",
            owners: { "a-1": "" },
            balances: { "a-1": 100 },
          });
          // Through the summary, into a projection's `rewrite` handler.
          expect((yield* Ref.get(tables.owners)).get("a-1")).toBe("");
          expect(yield* Ref.get(tables.rewrote)).toEqual([
            {
              projection: "Owners",
              key: "a-1",
              before: new Opened({ customerId: "c-1", owner: "Sam" }),
              after: new Opened({ customerId: "c-1", owner: "" }),
            },
          ]);

          // Through the summary and a projection, into the entries of a stream: each keeps its seq.
          expect(yield* cardsOf("a-1")).toEqual([
            [1, "", 0],
            [2, "", 100],
          ]);

          // The instance takes commands again, at the version it had.
          const next = yield* accounts.send(new Deposit({ id: "a-1", amount: 5 }));
          expect(next.version).toBe(5);
          expect(next.reply).toEqual({ balance: 105 });
          yield* Cards.caughtUp(next);
          expect(yield* cardsOf("a-1")).toEqual([
            [1, "", 0],
            [2, "", 100],
            [3, "", 105],
          ]);
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "undoing an instance's latest events never reuses their sequence numbers",
      () =>
        Effect.gen(function* () {
          const { accounts } = yield* seeded;
          expect(yield* cardsOf("a-1")).toEqual([
            [1, "Sam", 0],
            [2, "Sam", 100],
          ]);

          // Back to how the account stood after its second event.
          const receipt = yield* accounts.rewrite("a-1", new UndoSince({ since: 2 }));
          expect(receipt.changed).toBe(2);
          yield* accounts.rewritten(receipt);
          expect(yield* stored("Account", "a-1")).toEqual([
            [1, "Opened"],
            [2, "Noted"],
          ]);
          expect(yield* accounts.get("a-1")).toMatchObject({ balance: 0, notes: 1 });
          expect(Option.getOrNull(yield* (yield* Summary).get(Account.ref("a-1")))).toMatchObject({
            balance: 0,
          });

          // The next command follows the undone events: every consumer receives it.
          const next = yield* accounts.send(new Deposit({ id: "a-1", amount: 5 }));
          expect(next.version).toBe(5);
          expect(next.reply).toEqual({ balance: 5 });
          yield* Cards.caughtUp(next);
          const summary = yield* (yield* Summary).get(Account.ref("a-1"), { atLeast: next });
          expect(Option.getOrNull(summary)).toMatchObject({ balance: 5 });
          expect((yield* cardsOf("a-1")).at(-1)).toEqual([3, "Sam", 5]);
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "a rewrite runs once per id, and changes nothing the second time",
      () =>
        Effect.gen(function* () {
          const { accounts } = yield* seeded;
          const rewrite = new ForgetOwner({ customerId: "c-1" });
          const first = yield* accounts.rewrite("a-1", rewrite, { rewriteId: "forget-1" });
          const again = yield* accounts.rewrite("a-1", rewrite, { rewriteId: "forget-1" });
          expect(again).toEqual(first);
          const second = yield* accounts.rewrite("a-1", rewrite, { rewriteId: "forget-2" });
          expect(second.changed).toBe(0);
          yield* accounts.rewritten(second);
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "a command sent again after a rewrite answers with its events as they are now",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Account;
          const open = new Open({ id: "a-9", customerId: "c-9", owner: "Alex" });
          const first = yield* accounts.send(open, { commandId: "open-a-9" });
          expect(first.events).toEqual([new Opened({ customerId: "c-9", owner: "Alex" })]);
          yield* accounts.rewrite("a-9", new ForgetOwner({ customerId: "c-9" }));
          const again = yield* accounts.send(open, { commandId: "open-a-9" });
          expect(again.version).toBe(first.version);
          expect(again.events).toEqual([new Opened({ customerId: "c-9", owner: "" })]);
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "a rewrite that breaks an invariant changes nothing",
      () =>
        Effect.gen(function* () {
          const { accounts } = yield* seeded;
          const before = yield* stored("Account", "a-1");
          const refused = yield* Effect.flip(accounts.rewrite("a-1", new Overdraw()));
          expect(refused).toMatchObject({
            _tag: "InvariantBroken",
            invariant: "neverOverdrawn",
            rewrite: "Overdraw",
          });
          expect(yield* stored("Account", "a-1")).toEqual(before);
          expect((yield* accounts.get("a-1")).balance).toBe(100);
          // It let go of the instance.
          yield* accounts.send(new Deposit({ id: "a-1", amount: 1 }));
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "deleting an instance removes it from every view and projection",
      () =>
        Effect.gen(function* () {
          const { customers, dashboards } = yield* seeded;
          const tables = yield* Tables;
          yield* Directory.caughtUp({ stream: "Customer/c-1", version: 1 });
          expect((yield* Ref.get(tables.directory)).get("c-1")).toBe("Sam");

          const receipt = yield* customers.rewrite("c-1", new DeleteCustomer());
          expect(receipt.changed).toBe(1);
          yield* customers.rewritten(receipt);

          expect(yield* stored("Customer", "c-1")).toEqual([]);
          expect(yield* customers.get("c-1")).toEqual({ name: "" });
          expect((yield* Ref.get(tables.directory)).has("c-1")).toBe(false);
          expect(yield* Ref.get(tables.rewrote)).toEqual([
            {
              projection: "Directory",
              key: "c-1",
              before: new Registered({ name: "Sam" }),
              after: undefined,
            },
          ]);
          // The dashboard still has the account's part, and no name.
          expect(Option.getOrNull(yield* dashboards.get(Customer.ref("c-1")))).toEqual({
            name: "",
            owners: { "a-1": "Sam" },
            balances: { "a-1": 100 },
          });
          // Its id is not reused for another history: the next event follows the last.
          const next = yield* customers.send(new Register({ id: "c-1", name: "New" }));
          expect(next.version).toBe(2);
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "a rewrite that moves an event to another key takes it from one and gives it to the other",
      () =>
        Effect.gen(function* () {
          const { customers, accounts, dashboards } = yield* seeded;
          const tables = yield* Tables;
          const kim = yield* customers.send(new Register({ id: "c-2", name: "Kim" }));
          yield* dashboards.get(Customer.ref("c-2"), {
            atLeast: { stream: kim.stream, version: kim.version },
          });

          const receipt = yield* accounts.rewrite("a-1", new Reassign({ to: "c-2" }));
          yield* accounts.rewritten(receipt);

          expect(Option.getOrNull(yield* dashboards.get(Customer.ref("c-1")))).toEqual({
            name: "Sam",
            owners: {},
            balances: {},
          });
          expect(Option.getOrNull(yield* dashboards.get(Customer.ref("c-2")))).toEqual({
            name: "Kim",
            owners: { "a-1": "Sam" },
            balances: { "a-1": 100 },
          });
          expect(yield* Ref.get(tables.rewrote)).toEqual([
            {
              projection: "Owners",
              key: "a-1",
              before: new Opened({ customerId: "c-1", owner: "Sam" }),
              after: new Opened({ customerId: "c-2", owner: "Sam" }),
            },
          ]);
          // What the account does next reaches its new customer only.
          const next = yield* accounts.send(new Deposit({ id: "a-1", amount: 1 }));
          yield* dashboards.waitFor(Customer.ref("c-2"), { balances: { "a-1": 101 } } as never, {
            timeout: "10 seconds",
          });
          expect(next.version).toBe(5);
          expect(Option.getOrNull(yield* dashboards.get(Customer.ref("c-1")))).toEqual({
            name: "Sam",
            owners: {},
            balances: {},
          });
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "deleting an instance empties the views and projections built from it alone",
      () =>
        Effect.gen(function* () {
          const { accounts, dashboards } = yield* seeded;
          const tables = yield* Tables;
          const receipt = yield* accounts.rewrite("a-1", new DeleteAccount());
          expect(receipt.changed).toBe(4);
          yield* accounts.rewritten(receipt);

          expect(yield* stored("Account", "a-1")).toEqual([]);
          expect(Option.isNone(yield* (yield* Summary).get(Account.ref("a-1")))).toBe(true);
          expect(Option.getOrNull(yield* dashboards.get(Customer.ref("c-1")))).toEqual({
            name: "Sam",
            owners: {},
            balances: {},
          });
          expect((yield* Ref.get(tables.owners)).has("a-1")).toBe(false);
          expect(yield* cardsOf("a-1")).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "a compaction replaces the history with its roll-up and hands over what it removes",
      () =>
        Effect.gen(function* () {
          const { accounts } = yield* seeded;
          const tables = yield* Tables;
          const before = yield* accounts.get("a-1");

          const lossy = yield* Effect.flip(accounts.compact("a-1", Forget));
          expect(lossy._tag).toBe("CompactionLossy");
          expect(yield* stored("Account", "a-1")).toHaveLength(4);

          const receipt = yield* accounts.compact("a-1", BringForward);
          expect(receipt).toEqual({ stream: "Account/a-1", version: 5, compacted: 4 });
          expect(yield* stored("Account", "a-1")).toEqual([[5, "BroughtForward"]]);
          expect(yield* accounts.get("a-1")).toEqual(before);
          expect(yield* Ref.get(tables.archived)).toEqual([
            { stream: "Account/a-1", seqs: [1, 2, 3, 4] },
          ]);
          // Projections keep what they built, and commands go on.
          expect((yield* Ref.get(tables.owners)).get("a-1")).toBe("Sam");
          const next = yield* accounts.send(new Deposit({ id: "a-1", amount: 1 }));
          expect(next.reply).toEqual({ balance: 101 });
          const summary = yield* (yield* Summary).get(Account.ref("a-1"), {
            atLeast: { stream: next.stream, version: next.version },
          });
          expect(Option.getOrNull(summary)).toEqual({
            customerId: "c-1",
            owner: "Sam",
            balance: 101,
          });
          // Nothing to do when nothing was committed since.
          yield* accounts.compact("a-1", BringForward);
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "a view fed by many instances keeps what it built when one of them compacts",
      () =>
        Effect.gen(function* () {
          const { accounts } = yield* seeded;
          const ledgers = yield* Ledger;
          yield* accounts.send(new Open({ id: "a-2", customerId: "c-1", owner: "Sam" }));
          yield* accounts.send(new Deposit({ id: "a-2", amount: 50 }));
          yield* accounts.compact("a-1", BringForward);
          const next = yield* accounts.send(new Deposit({ id: "a-1", amount: 1 }));
          // The roll-up stands for events the key holds: it adds nothing to them.
          const ledger = yield* ledgers.get("all", {
            atLeast: { stream: next.stream, version: next.version },
          });
          expect(Option.getOrNull(ledger)).toEqual({
            total: 151,
            notes: 2,
            owners: { "a-1": "Sam", "a-2": "Sam" },
          });
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "a rewrite after a compaction reaches the events a view kept",
      () =>
        Effect.gen(function* () {
          const { accounts, dashboards } = yield* seeded;
          yield* accounts.compact("a-1", BringForward);
          const receipt = yield* accounts.rewrite("a-1", new ForgetOwnerForGood());
          // The roll-up is all the instance holds.
          expect(receipt.changed).toBe(1);
          yield* accounts.rewritten(receipt);

          expect(yield* accounts.get("a-1")).toEqual({
            customerId: "c-1",
            owner: "",
            balance: 100,
            notes: 0,
          });
          expect(Option.getOrNull(yield* (yield* Summary).get(Account.ref("a-1")))).toEqual({
            customerId: "c-1",
            owner: "",
            balance: 100,
          });
          expect(Option.getOrNull(yield* (yield* Ledger).get("all"))).toEqual({
            total: 100,
            notes: 0,
            owners: { "a-1": "" },
          });
          // Through the summary, into the view keyed by the customer.
          expect(Option.getOrNull(yield* dashboards.get(Customer.ref("c-1")))).toEqual({
            name: "Sam",
            owners: { "a-1": "" },
            balances: { "a-1": 100 },
          });
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "a rewrite after a compaction that moves an event takes the kept copy from one key, and the roll-up reaches the other",
      () =>
        Effect.gen(function* () {
          const { accounts } = yield* seeded;
          const holders = yield* Holders;
          yield* accounts.compact("a-1", BringForward);
          yield* accounts.rewritten(yield* accounts.rewrite("a-1", new Reassign({ to: "c-2" })));

          expect(Option.isNone(yield* holders.get(Customer.ref("c-1")))).toBe(true);
          // It never held the account's events: the roll-up stands for them.
          expect(Option.getOrNull(yield* holders.get(Customer.ref("c-2")))).toEqual({
            owners: { "a-1": "Sam" },
          });
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "a rewrite of one instance folds a key fed by hundreds of them again",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Account;
          const ledgers = yield* Ledger;
          // Past a page of the key's stored inputs: 250 accounts, three events each.
          const ids = Array.from({ length: 250 }, (_, i) => `w-${i}`);
          const last = yield* Effect.forEach(
            ids,
            (id) =>
              Effect.gen(function* () {
                yield* accounts.send(new Open({ id, customerId: "c-9", owner: id }));
                yield* accounts.send(new Note({ id, text: "hello" }));
                return yield* accounts.send(new Deposit({ id, amount: 2 }));
              }),
            { concurrency: 10 },
          );
          for (const receipt of last) {
            yield* ledgers.get("all", {
              atLeast: { stream: receipt.stream, version: receipt.version },
            });
          }
          const receipt = yield* accounts.rewrite("w-7", new ForgetOwner({ customerId: "c-9" }));
          yield* accounts.rewritten(receipt, { timeout: "30 seconds" });

          const ledger = Option.getOrNull(yield* ledgers.get("all"));
          expect(ledger?.total).toBe(500);
          expect(ledger?.notes).toBe(249);
          expect(ledger?.owners["w-7"]).toBe("");
          expect(Object.values(ledger?.owners ?? {}).filter((owner) => owner !== "")).toHaveLength(
            249,
          );
          // The key goes on from there.
          const next = yield* accounts.send(new Deposit({ id: "w-7", amount: 1 }));
          const after = yield* ledgers.get("all", {
            atLeast: { stream: next.stream, version: next.version },
          });
          expect(Option.getOrNull(after)?.total).toBe(501);
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 120_000 },
    );

    it.live(
      "deleting an instance that has compacted empties the views built from it",
      () =>
        Effect.gen(function* () {
          const { accounts, dashboards } = yield* seeded;
          yield* accounts.send(new Open({ id: "a-2", customerId: "c-1", owner: "Sam" }));
          const other = yield* accounts.send(new Deposit({ id: "a-2", amount: 50 }));
          yield* (yield* Ledger).get("all", {
            atLeast: { stream: other.stream, version: other.version },
          });
          yield* accounts.compact("a-1", BringForward);
          const receipt = yield* accounts.rewrite("a-1", new DeleteAccount());
          yield* accounts.rewritten(receipt);

          expect(yield* stored("Account", "a-1")).toEqual([]);
          expect(Option.isNone(yield* (yield* Summary).get(Account.ref("a-1")))).toBe(true);
          // The other account's events stay where they were.
          expect(Option.getOrNull(yield* (yield* Ledger).get("all"))).toEqual({
            total: 50,
            notes: 0,
            owners: { "a-2": "Sam" },
          });
          const dashboard = Option.getOrNull(yield* dashboards.get(Customer.ref("c-1")));
          expect(dashboard?.balances).toEqual({ "a-2": 50 });
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform))),
      { timeout: 60_000 },
    );

    it.live(
      "an instance compacts by itself once it holds more events than its Layer allows",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Account;
          const tables = yield* Tables;
          yield* accounts.send(new Open({ id: "a-2", customerId: "c-2", owner: "Kim" }));
          for (let i = 0; i < 4; i++) yield* accounts.send(new Deposit({ id: "a-2", amount: 1 }));
          // Five events: one more than the Layer allows.
          const archived = yield* Ref.get(tables.archived).pipe(
            Effect.repeat({
              until: (all) => all.length > 0,
              times: 200,
              schedule: Schedule.spaced("20 millis"),
            }),
          );
          expect(archived).toEqual([{ stream: "Account/a-2", seqs: [1, 2, 3, 4, 5] }]);
          expect(yield* stored("Account", "a-2")).toEqual([[6, "BroughtForward"]]);
          expect((yield* accounts.get("a-2")).balance).toBe(4);
        }).pipe(Effect.scoped, Effect.provide(bankOn(platform, 4))),
      { timeout: 60_000 },
    );
  });
}

// ---------------------------------------------------------------- a decision's receipt

/** Removes who a transfer came from. */
class HideSender extends Domain.Rewrite("HideSender", {
  of: Decisions.Account,
  events: {
    TransferReceived: (event) =>
      new Decisions.TransferReceived({ ...event, from: Decisions.AccountId.make("hidden") }),
  },
}) {}

class Transfers extends Domain.Model("Transfers", {
  aggregates: [Decisions.Account],
  decisions: [Decisions.Transfer],
  rewrites: [HideSender],
}) {}

for (const platform of Object.keys(platforms) as ReadonlyArray<keyof typeof platforms>) {
  describe(`Domain rewrites and decisions, ${platform}`, { tags: ["unit", "local"] }, () => {
    it.live(
      "a decision sent again after a rewrite answers with its events as they are now",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Decisions.Account;
          const transfers = yield* Decisions.Transfer;
          const from = Decisions.AccountId.make("a");
          const to = Decisions.AccountId.make("b");
          yield* accounts.send(new Decisions.Deposit({ accountId: from, amount: 100 }));
          const transfer = new Decisions.TransferMoney({ from, to, amount: 30 });
          const first = yield* transfers.send(transfer, { commandId: "t-1" });
          expect(first.events).toEqual([
            new Decisions.TransferSent({ to, amount: 30 }),
            new Decisions.TransferReceived({ from, amount: 30 }),
          ]);

          yield* accounts.rewrite(to, new HideSender());

          const again = yield* transfers.send(transfer, { commandId: "t-1" });
          expect(again.commits).toEqual(first.commits);
          expect(again.events).toEqual([
            new Decisions.TransferSent({ to, amount: 30 }),
            new Decisions.TransferReceived({
              from: Decisions.AccountId.make("hidden"),
              amount: 30,
            }),
          ]);
          expect(yield* accounts.get(from)).toEqual({ balance: 70 });
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Transfers.layer(Layer.empty).pipe(Layer.provideMerge(platforms[platform]())),
          ),
        ),
      { timeout: 60_000 },
    );
  });
}

describe("Domain rewrites, data stored before them", { tags: ["unit", "local"] }, () => {
  it.live(
    "a view's inputs and a command's receipt stored the old way are rewritten too",
    () => {
      const disk: Disk = { objects: new Map() };
      return Effect.gen(function* () {
        const { accounts, dashboards } = yield* seeded;
        const open = new Open({ id: "a-7", customerId: "c-1", owner: "Sam" });
        const first = yield* accounts.send(open, { commandId: "open-a-7" });
        yield* (yield* Summary).get(Account.ref("a-7"), {
          atLeast: { stream: first.stream, version: first.version },
        });
        yield* dashboards.waitFor(Customer.ref("c-1"), { balances: { "a-7": 0 } } as never, {
          timeout: "10 seconds",
        });
        // As they were stored before rewrites: a view's input is its delivery alone,
        // and a receipt holds a copy of its events.
        let inputs = 0;
        let receipts = 0;
        for (const { data } of disk.objects.values()) {
          for (const [key, value] of data) {
            if (key.startsWith("in:") && typeof value === "object" && value !== null) {
              const row = value as { readonly delivery?: unknown; readonly seqs?: unknown };
              if (row.seqs === undefined) continue;
              data.set(key, row.delivery);
              inputs += 1;
            }
            if (key === "receipt:open-a-7") {
              data.set(key, {
                _tag: "Accepted",
                receipt: {
                  stream: "Account/a-7",
                  version: 1,
                  events: [{ _tag: "Opened", customerId: "c-1", owner: "Sam" }],
                  reply: null,
                },
              });
              receipts += 1;
            }
          }
        }
        expect(inputs).toBeGreaterThan(0);
        expect(receipts).toBe(1);

        for (const id of ["a-1", "a-7"]) {
          yield* accounts.rewritten(
            yield* accounts.rewrite(id, new ForgetOwner({ customerId: "c-1" })),
          );
        }
        expect(Option.getOrNull(yield* dashboards.get(Customer.ref("c-1")))).toEqual({
          name: "Sam",
          owners: { "a-1": "", "a-7": "" },
          balances: { "a-1": 100, "a-7": 0 },
        });
        const again = yield* accounts.send(open, { commandId: "open-a-7" });
        expect(again.events).toEqual([new Opened({ customerId: "c-1", owner: "" })]);
        // Nothing stored still holds the name.
        const held = [...disk.objects.values()].flatMap(({ data, cls }) =>
          [...data].flatMap(([key, value]) =>
            JSON.stringify(value).includes('"owner":"Sam"') ? [`${cls} ${key}`] : [],
          ),
        );
        expect(held).toEqual([]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Bank.layer(handlers()).pipe(
            Layer.provideMerge(TablesLive),
            Layer.provideMerge(onDurableObjects(disk)),
          ),
        ),
      );
    },
    { timeout: 60_000 },
  );
});

// ---------------------------------------------------------------- a compaction and a consumer behind it

class OneView extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [Summary],
  rewrites: [ForgetOwnerForGood],
  compactions: [BringForward],
}) {}
class TwoViews extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [Summary, Ledger],
  rewrites: [ForgetOwner, Reassign],
  compactions: [BringForward],
}) {}
class ThreeViews extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [Summary, Ledger, Holders],
  rewrites: [ForgetOwner, Reassign],
  compactions: [BringForward],
}) {}

const BringForwardLive = BringForward.toLayer(
  Effect.succeed(Effect.fn(function* (_batch: Domain.Compaction.Batch<typeof Account>) {})),
);

/** An in-memory platform that outlives the models built on it, and delivers only when drained. */
const outliving = () => {
  const hosted = Memory.make({ manual: true });
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      yield* hosted.control.drain;
      if (yield* hosted.control.idle) return;
      yield* Effect.sleep("1 millis");
    }
  });
  return {
    settle,
    deploy: <A, E, R>(
      model: { readonly layer: (handlers: any) => Layer.Layer<any, any, any> },
      effect: Effect.Effect<A, E, R>,
    ) =>
      effect.pipe(
        Effect.tap(() => settle),
        Effect.provide(model.layer(BringForwardLive).pipe(Layer.provide(hosted.layer))),
      ),
  };
};

const ledger = Effect.gen(function* () {
  return Option.getOrNull(yield* (yield* Ledger).get("all"));
});

describe("Domain compactions, a consumer behind", { tags: ["unit", "local"] }, () => {
  it.live("the events a view added since has yet to read stay until it has read them", () =>
    Effect.gen(function* () {
      const bank = outliving();
      yield* bank.deploy(
        OneView,
        Effect.gen(function* () {
          const accounts = yield* Account;
          yield* accounts.send(new Open({ id: "a-1", customerId: "c-1", owner: "Sam" }));
          yield* accounts.send(new Note({ id: "a-1", text: "call Sam back" }));
          yield* accounts.send(new Deposit({ id: "a-1", amount: 100 }));
        }),
      );
      const read = yield* bank.deploy(
        TwoViews,
        Effect.gen(function* () {
          // Before the ledger has read the account.
          yield* (yield* Account).compact("a-1", BringForward);
          const kept = yield* stored("Account", "a-1");
          yield* bank.settle;
          return { kept, ledger: yield* ledger };
        }),
      );
      expect(read.kept).toEqual([
        [1, "Opened"],
        [2, "Noted"],
        [3, "Deposited"],
        [4, "BroughtForward"],
      ]);
      // It read the events, so the roll-up adds nothing to them.
      expect(read.ledger).toEqual({ total: 100, notes: 1, owners: { "a-1": "Sam" } });
    }),
  );
});

describe("Domain rewrites, a consumer behind", { tags: ["unit", "local"] }, () => {
  const opened = Effect.gen(function* () {
    const accounts = yield* Account;
    yield* accounts.send(new Open({ id: "a-1", customerId: "c-1", owner: "Sam" }));
    yield* accounts.send(new Note({ id: "a-1", text: "call Sam back" }));
    yield* accounts.send(new Deposit({ id: "a-1", amount: 100 }));
  });

  it.live("a view still reading an instance's history gets its events as a rewrite left them", () =>
    Effect.gen(function* () {
      const bank = outliving();
      yield* bank.deploy(OneView, opened);
      const read = yield* bank.deploy(
        TwoViews,
        Effect.gen(function* () {
          const accounts = yield* Account;
          // Before the ledger has read the account.
          const receipt = yield* accounts.rewrite("a-1", new ForgetOwner({ customerId: "c-1" }));
          yield* bank.settle;
          yield* accounts.rewritten(receipt, { timeout: "5 seconds" });
          return yield* ledger;
        }),
      );
      expect(read).toEqual({ total: 100, notes: 0, owners: { "a-1": "" } });
    }),
  );

  it.live(
    "a rewrite that moves an event while a view reads the history gives it to the new key alone",
    () =>
      Effect.gen(function* () {
        const bank = outliving();
        yield* bank.deploy(OneView, opened);
        const read = yield* bank.deploy(
          ThreeViews,
          Effect.gen(function* () {
            const accounts = yield* Account;
            const holders = yield* Holders;
            const receipt = yield* accounts.rewrite("a-1", new Reassign({ to: "c-2" }));
            yield* bank.settle;
            yield* accounts.rewritten(receipt, { timeout: "5 seconds" });
            return {
              was: Option.getOrNull(yield* holders.get(Customer.ref("c-1"))),
              is: Option.getOrNull(yield* holders.get(Customer.ref("c-2"))),
            };
          }),
        );
        expect(read).toEqual({ was: null, is: { owners: { "a-1": "Sam" } } });
      }),
  );
});

describe("Domain rewrites, a key still reading its history", { tags: ["unit", "local"] }, () => {
  it.live("a rewrite after a compaction reaches the events a key has yet to apply", () =>
    Effect.gen(function* () {
      const bank = outliving();
      const read = yield* bank.deploy(
        OneView,
        Effect.gen(function* () {
          const accounts = yield* Account;
          // Nothing is delivered until the platform is drained: the summary's key
          // is told of the rewrite before it has applied the events it is for.
          yield* accounts.send(new Open({ id: "a-1", customerId: "c-1", owner: "Sam" }));
          yield* accounts.send(new Deposit({ id: "a-1", amount: 100 }));
          yield* accounts.compact("a-1", BringForward);
          yield* accounts.rewrite("a-1", new ForgetOwnerForGood());
          yield* bank.settle;
          return Option.getOrNull(yield* (yield* Summary).get(Account.ref("a-1")));
        }),
      );
      expect(read).toEqual({ customerId: "c-1", owner: "", balance: 100 });
    }),
  );
});

describe("Domain rewrites, in a story", { tags: ["unit", "local"] }, () => {
  const story = Story.make(Bank, { layer: handlers().pipe(Layer.provideMerge(TablesLive)) });
  const account = Account.ref("a-1");

  it.effect("a rewrite and a compaction are steps", () =>
    story(
      Story.given(
        account,
        new Opened({ customerId: "c-1", owner: "Sam" }),
        new Noted({ text: "call Sam back" }),
        new Deposited({ amount: 100, balance: 100 }),
      ),
      Story.rewrite(account, new ForgetOwner({ customerId: "c-1" })),
      Story.state(account, { owner: "", balance: 100, notes: 0 }),
      Story.view(Summary, account, { owner: "", balance: 100 }),
      Story.view(Dashboard, Customer.ref("c-1"), { owners: { "a-1": "" } }),
      Story.when(new Deposit({ id: "a-1", amount: 5 })),
      Story.then(account, new Deposited({ amount: 5, balance: 105 })),
      Story.compact(account, BringForward),
      Story.then(
        account,
        new BroughtForward({
          state: { customerId: "c-1", owner: "", balance: 105, notes: 0 },
        }),
      ),
      Story.state(account, { balance: 105 }),
    ),
  );

  it.effect("a rewrite that breaks an invariant fails the story", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        story(
          Story.given(account, new Deposited({ amount: 100, balance: 100 })),
          Story.rewrite(account, new Overdraw()),
        ),
      );
      expect(String((failure as { readonly message?: string }).message)).toContain(
        "neverOverdrawn",
      );
    }),
  );
});

describe("Domain rewrites, the model", { tags: ["unit", "local"] }, () => {
  it.effect("fails to build when a projection a rewrite reaches has no rewrite handler", () =>
    Effect.gen(function* () {
      const DirectoryWithout = Directory.toLayer(Effect.succeed(Effect.fn(function* (_batch) {})));
      const exit = yield* Layer.build(
        Bank.layer(
          Layer.mergeAll(
            DirectoryWithout,
            OwnersLive,
            CardsLive,
            archive(BringForward),
            archive(Forget),
          ),
        ).pipe(Layer.provideMerge(TablesLive), Layer.provideMerge(InMemory)),
      ).pipe(Effect.scoped, Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const defects = Exit.isFailure(exit)
        ? exit.cause.reasons.flatMap((reason) => (reason._tag === "Die" ? [reason.defect] : []))
        : [];
      expect(defects.map((defect) => (defect as Error).message)).toEqual([
        "DeleteCustomer changes events Directory is given, and Directory has no rewrite handler: return { write, rewrite } from its Layer (a rewrite that does nothing is still written down)",
      ]);
    }),
  );
});
