import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const Cents = Schema.Int.check(Schema.isGreaterThan(0));

export class Paid extends Domain.Event("Paid", { amount: Cents }) {}

export class Reserved extends Domain.Event("Reserved", { amount: Cents }) {}

export class Captured extends Domain.Event("Captured", {}) {}

export class NotEnough extends Domain.Rejection("NotEnough", {}) {}

export class Pay extends Domain.Command("Pay", {
  input: { id: Schema.String, amount: Cents },
  events: [Paid],
}) {}

export class Reserve extends Domain.Command("Reserve", {
  input: { id: Schema.String, amount: Cents },
  events: [Reserved],
  rejects: [NotEnough],
}) {}

export class Capture extends Domain.Command("Capture", {
  input: { id: Schema.String },
  events: [Captured],
}) {}

const definition = {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Int, reserved: Schema.Int }),
  initial: { balance: 0, reserved: 0 },
  commands: [Pay, Reserve, Capture],
} as const;

/**
 * Money is reserved, then captured. `Reserve` checks there is enough, so the
 * balance never goes below zero. That is true and not provable as written:
 * nothing says the reserved amount is covered, so the prover starts `Capture`
 * from a balance of nothing with money reserved.
 */
export class Escrow extends Domain.Aggregate("Escrow", {
  ...definition,
  keyOf: (cmd) => cmd.id,
  invariants: {
    NeverOverdrawn: (hold) => hold.balance >= 0,
  },
  decide: {
    Pay: (_, command) => [new Paid({ amount: command.amount })],
    Reserve: (hold, command) =>
      hold.reserved + command.amount > hold.balance
        ? new NotEnough()
        : [new Reserved({ amount: command.amount })],
    Capture: (hold) => (hold.reserved === 0 ? [] : [new Captured({})]),
  },
  evolve: {
    Paid: (hold, event) => ({ ...hold, balance: hold.balance + event.amount }),
    Reserved: (hold, event) => ({ ...hold, reserved: hold.reserved + event.amount }),
    Captured: (hold) => ({ balance: hold.balance - hold.reserved, reserved: 0 }),
  },
}) {}

/** The same aggregate, with the rule that was true all along written down. */
export class Covered extends Domain.Aggregate("Covered", {
  ...definition,
  keyOf: (cmd) => cmd.id,
  invariants: {
    NeverOverdrawn: (hold) => hold.balance >= 0,
    ReservedIsCovered: (hold) => hold.reserved >= 0 && hold.reserved <= hold.balance,
  },
  decide: {
    Pay: (_, command) => [new Paid({ amount: command.amount })],
    Reserve: (hold, command) =>
      hold.reserved + command.amount > hold.balance
        ? new NotEnough()
        : [new Reserved({ amount: command.amount })],
    Capture: (hold) => (hold.reserved === 0 ? [] : [new Captured({})]),
  },
  evolve: {
    Paid: (hold, event) => ({ ...hold, balance: hold.balance + event.amount }),
    Reserved: (hold, event) => ({ ...hold, reserved: hold.reserved + event.amount }),
    Captured: (hold) => ({ balance: hold.balance - hold.reserved, reserved: 0 }),
  },
}) {}
