import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const Amount = Schema.Int.check(Schema.isGreaterThan(0));

export class Sent extends Domain.Event("Sent", { amount: Schema.Int }) {}

export class Received extends Domain.Event("Received", { amount: Schema.Int }) {}

export class NotEnough extends Domain.Rejection("NotEnough") {}

/** A purse only decisions record on: it folds what they send and receive. */
export class Purse extends Domain.Aggregate("Purse", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  invariants: { NeverNegative: (purse) => purse.balance >= 0 },
  events: [Sent, Received],
  evolve: {
    Sent: (purse, event) => ({ balance: purse.balance - event.amount }),
    Received: (purse, event) => ({ balance: purse.balance + event.amount }),
  },
}) {}

export class MoveMoney extends Domain.Command("MoveMoney", {
  input: { from: Schema.String, to: Schema.String, amount: Amount },
  events: [Sent, Received],
  rejects: [NotEnough],
}) {}

/** Takes from one purse what it gives the other, and only what is there. */
export class Move extends Domain.Decision(MoveMoney, {
  reads: { from: Purse, to: Purse },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    cmd.amount > from.state.balance
      ? new NotEnough()
      : [
          from.record(new Sent({ amount: cmd.amount })),
          to.record(new Received({ amount: cmd.amount })),
        ],
  transitions: {
    MoneyIsConserved: ({ before, after }) =>
      after.from.balance + after.to.balance === before.from.balance + before.to.balance,
  },
}) {}

export class OverdrawMoney extends Domain.Command("OverdrawMoney", {
  input: { from: Schema.String, to: Schema.String, amount: Amount },
  events: [Sent, Received],
}) {}

/** Forgets to look at the balance. */
export class Overdraw extends Domain.Decision(OverdrawMoney, {
  reads: { from: Purse, to: Purse },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) => [
    from.record(new Sent({ amount: cmd.amount })),
    to.record(new Received({ amount: cmd.amount })),
  ],
}) {}

export class SkimMoney extends Domain.Command("SkimMoney", {
  input: { from: Schema.String, to: Schema.String, amount: Amount },
  events: [Sent, Received],
  rejects: [NotEnough],
}) {}

/** Keeps a cent of every move: both purses stay in order, and money is lost. */
export class Skim extends Domain.Decision(SkimMoney, {
  reads: { from: Purse, to: Purse },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    cmd.amount > from.state.balance
      ? new NotEnough()
      : [
          from.record(new Sent({ amount: cmd.amount })),
          to.record(new Received({ amount: cmd.amount - 1 })),
        ],
  transitions: {
    MoneyIsConserved: ({ before, after }) =>
      after.from.balance + after.to.balance === before.from.balance + before.to.balance,
  },
}) {}

export class ChargeBoth extends Domain.Command("ChargeBoth", {
  input: { first: Schema.String, second: Schema.String, fee: Amount },
  events: [Sent],
  rejects: [NotEnough],
}) {}

/**
 * Charges two purses a fee each, after checking each can pay it. Named the
 * same purse twice, it charges that one twice, and checked it for one fee.
 */
export class Charge extends Domain.Decision(ChargeBoth, {
  reads: { first: Purse, second: Purse },
  keyOf: (cmd) => ({ first: cmd.first, second: cmd.second }),
  decide: ({ first, second }, cmd) =>
    cmd.fee > first.state.balance || cmd.fee > second.state.balance
      ? new NotEnough()
      : [first.record(new Sent({ amount: cmd.fee })), second.record(new Sent({ amount: cmd.fee }))],
}) {}

export class PayOut extends Domain.Command("PayOut", {
  input: { from: Schema.String, to: Schema.Array(Schema.String), amount: Amount },
  events: [Sent, Received],
  rejects: [NotEnough],
}) {}

/** Pays the same amount to each of several purses, when the first holds enough for all. */
export class Payout extends Domain.Decision(PayOut, {
  reads: { from: Purse, to: Purse },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    cmd.amount * to.length > from.state.balance
      ? new NotEnough()
      : to.flatMap((purse) => [
          from.record(new Sent({ amount: cmd.amount })),
          purse.record(new Received({ amount: cmd.amount })),
        ]),
}) {}
