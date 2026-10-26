import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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
  decide: { Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

class Sent extends Domain.Event("Sent", { to: Schema.String, amount: Schema.Number }) {}
class Send extends Domain.Command("Send", {
  target: Schema.String,
  input: { to: Schema.String, amount: Schema.Number },
  events: [Sent],
}) {}
class Payment extends Domain.Aggregate("Payment", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Send],
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
class AlsoCards extends Domain.Projection("AlsoCards", {
  from: [Wallet],
  key: Wallet,
  on: [Deposited],
  writes: [WalletCard],
}) {}
class Broken extends Domain.Model("Broken", {
  aggregates: [Wallet, Payment],
  views: [Received],
  projections: [WalletCards, AlsoCards],
  streams: [WalletCard],
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

// The payload a client sends carries `target` and `commandId` beside the input.
class Move extends Domain.Command("Move", {
  target: Schema.String,
  // @ts-expect-error the payload uses `target` for the aggregate id
  input: { target: Schema.String, amount: Schema.Number },
}) {}
class Pay extends Domain.Command("Pay", {
  target: Schema.String,
  // @ts-expect-error the payload uses `commandId` for the idempotency key
  input: { commandId: Schema.String },
}) {}
class Transfer extends Domain.Aggregate("Transfer", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Move, Pay],
  decide: { Move: () => [], Pay: () => [] },
  evolve: {},
}) {}
class Reserved extends Domain.Model("Reserved", { aggregates: [Transfer] }) {}

/** The defect building a model's Layer dies with. */
const layerDefect = (layer: Layer.Layer<unknown, unknown, never>) => {
  const exit = Effect.runSyncExit(
    Layer.build(layer).pipe(Effect.scoped, Effect.provide(InMemory)) as Effect.Effect<unknown>,
  );
  return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
};

describe("Domain verify", () => {
  it("finds no problem in a correct model", () => {
    expect(Domain.verify(Bank)).toEqual([]);
  });

  it("returns every definition problem at once", () => {
    expect(Domain.verify(Broken).map((problem) => problem.message)).toEqual([
      "Received declares state without initial",
      "Received consumes 'Sent' from Payment, which is not keyed by Wallet: add keyOf.Sent",
      "WalletCard has two writers, WalletCards and AlsoCards: a stream key has exactly one",
    ]);
  });

  it("goes on past a problem to find the next one", () => {
    expect(Domain.verify(AlsoBroken).map((problem) => problem.message)).toEqual([
      expect.stringContaining("Ledger.initial does not match its state schema"),
      "Policy Notify: none of Payment emits 'Deposited'",
      "Policy Audit consumes Balance, which is not in the Domain",
    ]);
  });

  it("reports the problem that building the model's Layer fails on", () => {
    const [first] = Domain.verify(Broken);
    expect(
      layerDefect(
        Broken.layer(
          Layer.mergeAll(
            WalletCards.toLayer(Effect.succeed(() => Effect.void)),
            AlsoCards.toLayer(Effect.succeed(() => Effect.void)),
          ),
        ) as Layer.Layer<unknown, unknown, never>,
      ),
    ).toMatchObject({ _tag: "DefinitionError", message: first!.message });
  });

  it("refuses a command input field the payload uses itself", () => {
    expect(Domain.verify(Reserved).map((problem) => problem.message)).toEqual([
      "Move declares the input field 'target', which its payload uses itself",
      "Pay declares the input field 'commandId', which its payload uses itself",
    ]);
    expect(layerDefect(Reserved.layer() as Layer.Layer<unknown, unknown, never>)).toMatchObject({
      _tag: "DefinitionError",
      message: "Move declares the input field 'target', which its payload uses itself",
    });
  });
});
