import { Event, View } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Cents } from "../Money.ts";
import { Account } from "./Account.ts";

/** One movement of money on an account. */
export class StatementLine extends Event.make("StatementLine", {
  data: {
    kind: Schema.Literals([
      "deposit",
      "withdrawal",
      "transfer-in",
      "transfer-out",
      "refund",
      "settlement",
    ]),
    amount: Cents,
    balance: Cents,
  },
}) {}

const line =
  (kind: StatementLine["kind"]) =>
  (e: { readonly amount: number; readonly balanceAfter: number }) =>
    new StatementLine({ kind, amount: e.amount, balance: e.balanceAfter });

/** Every movement of money on an account, oldest first. Six events become one. */
export class Statement extends View.make("Statement", {
  from: [Account],
  key: Account,
  events: [StatementLine],
  emit: {
    MoneyDeposited: line("deposit"),
    MoneyWithdrawn: line("withdrawal"),
    TransferCredited: line("transfer-in"),
    TransferDebited: line("transfer-out"),
    TransferRefunded: line("refund"),
    SettlementReceived: line("settlement"),
  },
}) {}
