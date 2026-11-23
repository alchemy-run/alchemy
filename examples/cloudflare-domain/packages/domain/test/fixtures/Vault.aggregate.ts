import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const Positive = Schema.Int.check(Schema.isGreaterThan(0));

export const VaultState = Schema.Struct({
  owner: Schema.String,
  balance: Schema.Int,
  deposits: Schema.Int,
});

export class Opened extends Domain.Event("Opened", { owner: Schema.String }) {}
export class Deposited extends Domain.Event("Deposited", { amount: Positive }) {}
export class Withdrawn extends Domain.Event("Withdrawn", { amount: Positive }) {}
export class BroughtForward extends Domain.Event("BroughtForward", { state: VaultState }) {}
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
export class Vault extends Domain.Aggregate("Vault", {
  id: Schema.String,
  state: VaultState,
  initial: { owner: "", balance: 0, deposits: 0 },
  invariants: {
    NeverOverdrawn: (vault) => vault.balance >= 0,
    CountsItsDeposits: (vault) => vault.deposits >= 0,
  },
  commands: [Open, Deposit, Withdraw],
  events: [BroughtForward, Summed],
  keyOf: (command) => command.id,
  decide: {
    Open: (_, { owner }) => [new Opened({ owner })],
    Deposit: (_, { amount }) => [new Deposited({ amount })],
    Withdraw: (vault, { amount }) =>
      vault.balance < amount ? new TooLittle() : [new Withdrawn({ amount })],
  },
  evolve: {
    Opened: (vault, e) => ({ ...vault, owner: e.owner }),
    Deposited: (vault, e) => ({
      ...vault,
      balance: vault.balance + e.amount,
      deposits: vault.deposits + 1,
    }),
    Withdrawn: (vault, e) => ({ ...vault, balance: vault.balance - e.amount }),
    BroughtForward: (_, e) => e.state,
    Summed: (vault, e) => ({ ...vault, owner: e.owner, balance: e.balance }),
  },
}) {}
