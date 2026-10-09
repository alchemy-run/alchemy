import { Feed } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Cents } from "../Money.ts";
import { Account } from "./Account.ts";

/** Every movement of money on an account, oldest first. */
export class Statement extends Feed.make("Statement", {
  from: [Account],
  key: Account,
  entry: Schema.Struct({
    at: Schema.DateTimeUtc,
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
  }),
  map: {
    MoneyDeposited: (e, { at }) => ({
      at,
      kind: "deposit" as const,
      amount: e.amount,
      balance: e.balanceAfter,
    }),
    MoneyWithdrawn: (e, { at }) => ({
      at,
      kind: "withdrawal" as const,
      amount: e.amount,
      balance: e.balanceAfter,
    }),
    TransferCredited: (e, { at }) => ({
      at,
      kind: "transfer-in" as const,
      amount: e.amount,
      balance: e.balanceAfter,
    }),
    TransferDebited: (e, { at }) => ({
      at,
      kind: "transfer-out" as const,
      amount: e.amount,
      balance: e.balanceAfter,
    }),
    TransferRefunded: (e, { at }) => ({
      at,
      kind: "refund" as const,
      amount: e.amount,
      balance: e.balanceAfter,
    }),
    SettlementReceived: (e, { at }) => ({
      at,
      kind: "settlement" as const,
      amount: e.amount,
      balance: e.balanceAfter,
    }),
  },
}) {}
