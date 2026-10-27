import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// A wallet whose deposits a policy books in a ledger: the ledger's events have
// their own command id, and the deposit's id as their correlation id.
class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: { Deposit: (_, { amount }) => [new Deposited({ amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
  read: {},
}) {}

class Booked extends Domain.Event("Booked", { wallet: Schema.String, amount: Schema.Number }) {}
class Book extends Domain.Command("Book", {
  target: Schema.String,
  input: { wallet: Schema.String, amount: Schema.Number },
  events: [Booked],
}) {}
class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  commands: [Book],
  decide: { Book: (_, { wallet, amount }) => [new Booked({ wallet, amount })] },
  evolve: { Booked: (s, e) => ({ total: s.total + e.amount }) },
  read: {},
}) {}

class BookDeposits extends Domain.Policy("BookDeposits", { from: Wallet, on: [Deposited] }) {}
const BookDepositsLive = BookDeposits.toLayer(
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    return Effect.fn(function* ({ source, event }) {
      yield* ledger.send("main", new Book({ wallet: source.id, amount: event.amount }));
    });
  }),
);

class Bookings extends Domain.View("Bookings", {
  from: [Ledger],
  key: Ledger,
  state: Schema.Struct({ count: Schema.Number }),
  initial: { count: 0 },
  evolve: { Booked: (s) => ({ count: s.count + 1 }) },
}) {}

class Bank extends Domain.Model("Bank", {
  aggregates: [Wallet, Ledger],
  views: [Bookings],
  policies: [BookDeposits],
}) {}

class BankApi extends Domain.Api("BankApi", Deposit, Wallet, Ledger, Bookings) {}

const Hosted = Bank.layer(BookDepositsLive).pipe(Layer.provide(InMemory));

// The Api's `fetch` on a real HTTP server; the client speaks the wire protocol to it.
const Wire = Domain.protocolHttp("").pipe(
  Layer.provideMerge(
    Layer.unwrap(Effect.map(BankApi, (api) => HttpServer.serve()(api.fetch))).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  ),
  Layer.provideMerge(Hosted),
);

describe("Domain Api over the wire", () => {
  it.live("an envelope keeps its command id and correlation id", () =>
    Effect.gen(function* () {
      const bank = yield* BankApi.client;
      const local = yield* BankApi.clientInProcess;
      yield* bank.Deposit({ target: "w-1", amount: 5, commandId: "deposit-1" });

      const [wallet] = yield* bank.Wallet.events("w-1").pipe(Stream.take(1), Stream.runCollect);
      expect(wallet!.envelope).toMatchObject({
        commandId: "deposit-1",
        correlationId: "deposit-1",
      });

      // The policy's command has its own id, and carries the deposit's correlation id.
      const [booked] = yield* bank.Ledger.events("main").pipe(Stream.take(1), Stream.runCollect);
      expect(booked!.envelope.commandId).not.toBe("deposit-1");
      expect(booked!.envelope.correlationId).toBe("deposit-1");

      const [entry] = yield* bank.Bookings.events("main").pipe(Stream.take(1), Stream.runCollect);
      expect(entry!.envelope.correlationId).toBe("deposit-1");
      const page = yield* bank.Bookings.list("main");
      expect(page.entries[0]!.envelope.correlationId).toBe("deposit-1");

      // The wire gives what the in-process client gives.
      const [direct] = yield* local.Ledger.events("main").pipe(Stream.take(1), Stream.runCollect);
      expect(booked!.envelope).toEqual(direct!.envelope);
    }).pipe(Effect.scoped, Effect.provide(Wire)),
  );
});
