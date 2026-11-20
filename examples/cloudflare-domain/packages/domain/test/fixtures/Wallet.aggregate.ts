import * as Domain from "@alchemy.run/domain";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class BalanceSet extends Domain.Event("BalanceSet", { balance: Schema.Int }) {}

export class WalletEmptied extends Domain.Event("WalletEmptied", {}) {}

export class NothingToSpend extends Domain.Rejection("NothingToSpend", {}) {}

export class Fund extends Domain.Command("Fund", {
  input: { id: Schema.String, amount: Schema.Int.check(Schema.isGreaterThan(0)) },
  events: [BalanceSet],
}) {}

export class Spend extends Domain.Command("Spend", {
  input: { id: Schema.String, amount: Schema.Int.check(Schema.isGreaterThan(0)) },
  events: [BalanceSet],
  rejects: [NothingToSpend],
}) {}

export class Overspend extends Domain.Command("Overspend", {
  input: { id: Schema.String, amount: Schema.Int.check(Schema.isGreaterThan(0)) },
  events: [BalanceSet],
}) {}

export class Empty extends Domain.Command("Empty", {
  input: { id: Schema.String },
  events: [WalletEmptied],
}) {}

/** A wallet that has no balance until it is first funded. */
export class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Option(Schema.Int) }),
  initial: { balance: Option.none() },
  invariants: {
    NeverNegative: (wallet) => !Option.exists(wallet.balance, (balance) => balance < 0),
  },
  commands: [Fund, Spend, Overspend, Empty],
  keyOf: (cmd) => cmd.id,
  decide: {
    Fund: (state, command) => [
      new BalanceSet({
        balance: Option.getOrElse(state.balance, () => 0) + command.amount,
      }),
    ],
    Spend: (state, command) =>
      Option.match(state.balance, {
        onNone: () => new NothingToSpend({}),
        onSome: (balance) =>
          balance >= command.amount
            ? [new BalanceSet({ balance: balance - command.amount })]
            : new NothingToSpend({}),
      }),
    // Takes the amount whatever the wallet holds.
    Overspend: (state, command) =>
      state.balance.pipe(
        Option.map((balance) => [new BalanceSet({ balance: balance - command.amount })]),
        Option.getOrElse(() => []),
      ),
    Empty: (state) => (Option.isSome(state.balance) ? [new WalletEmptied({})] : []),
  },
  evolve: {
    BalanceSet: (state, event) => ({ ...state, balance: Option.some(event.balance) }),
    WalletEmptied: (state) => ({ ...state, balance: Option.none() }),
  },
}) {}
