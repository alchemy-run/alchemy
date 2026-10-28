import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
export class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
export class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: { Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

/** Every deposit to an account, in the order the view applied them: added in the second deploy. */
export class Deposits extends Domain.View("Deposits", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ amounts: Schema.Array(Schema.Number) }),
  initial: { amounts: [] },
  evolve: { Deposited: (s, e) => ({ amounts: [...s.amounts, e.amount] }) },
}) {}

/** The first deploy: accounts only. */
export class Before extends Domain.Model("Ledger", { aggregates: [Account] }) {}

/** The second deploy adds the view; its history must reach it. */
export class After extends Domain.Model("Ledger", { aggregates: [Account], views: [Deposits] }) {}

/** The view redefined: it now records each deposit doubled. Rebuilt by bumping its version. */
export class DoubledDeposits extends Domain.View("Deposits", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ amounts: Schema.Array(Schema.Number) }),
  initial: { amounts: [] },
  evolve: { Deposited: (s, e) => ({ amounts: [...s.amounts, e.amount * 2] }) },
}) {}

/** The third deploy: the redefined view, at version 1. */
export class Rebuilt extends Domain.Model("Ledger", {
  aggregates: [Account],
  views: [DoubledDeposits],
}) {}
