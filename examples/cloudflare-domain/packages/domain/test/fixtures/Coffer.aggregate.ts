import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const Positive = Schema.Int.check(Schema.isGreaterThan(0));

export const CofferState = Schema.Struct({
  owner: Schema.String,
  balance: Schema.Int,
  deposits: Schema.Int,
});

export class Opened extends Domain.Event("Opened", { owner: Schema.String }) {}
export class Deposited extends Domain.Event("Deposited", { amount: Positive }) {}
export class Withdrawn extends Domain.Event("Withdrawn", { amount: Positive }) {}
export class BroughtForward extends Domain.Event("BroughtForward", { state: CofferState }) {}
/** A roll-up that keeps the balance and forgets how many deposits made it. */
export class Summed extends Domain.Event("Summed", {
  owner: Schema.String,
  balance: Schema.Int,
}) {}

export class TooLittle extends Domain.Rejection("TooLittle") {}

export class Open extends Domain.Command("Open", {
  input: { id: Schema.String, owner: Schema.String },
  events: [Opened],
}) {}
export class Deposit extends Domain.Command("Deposit", {
  input: { id: Schema.String, amount: Positive },
  events: [Deposited],
}) {}
export class Withdraw extends Domain.Command("Withdraw", {
  input: { id: Schema.String, amount: Positive },
  events: [Withdrawn],
  rejects: [TooLittle],
}) {}

/** Money one person keeps: never below zero, and it counts its deposits. */
export class Coffer extends Domain.Aggregate("Coffer", {
  id: Schema.String,
  state: CofferState,
  initial: { owner: "", balance: 0, deposits: 0 },
  invariants: {
    NeverOverdrawn: (coffer) => coffer.balance >= 0,
    CountsItsDeposits: (coffer) => coffer.deposits >= 0,
  },
  commands: [Open, Deposit, Withdraw],
  events: [BroughtForward, Summed],
  keyOf: (command) => command.id,
  decide: {
    Open: (_, { owner }) => [new Opened({ owner })],
    Deposit: (_, { amount }) => [new Deposited({ amount })],
    Withdraw: (coffer, { amount }) =>
      coffer.balance < amount ? new TooLittle() : [new Withdrawn({ amount })],
  },
  evolve: {
    Opened: (coffer, e) => ({ ...coffer, owner: e.owner }),
    Deposited: (coffer, e) => ({
      ...coffer,
      balance: coffer.balance + e.amount,
      deposits: coffer.deposits + 1,
    }),
    Withdrawn: (coffer, e) => ({ ...coffer, balance: coffer.balance - e.amount }),
    BroughtForward: (_, e) => e.state,
    Summed: (coffer, e) => ({ ...coffer, owner: e.owner, balance: e.balance }),
  },
}) {}
