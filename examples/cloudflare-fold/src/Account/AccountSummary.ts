import { View } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { CustomerId } from "../Customer/CustomerId.ts";
import { Cents } from "../Money.ts";
import { Account } from "./Account.ts";

const setBalance = <V extends { balance: number }>(
  v: V,
  e: { readonly balanceAfter: number },
): V => ({
  ...v,
  balance: e.balanceAfter,
});

/** The current balance and status of one account. */
export class AccountSummary extends View.make("AccountSummary", {
  from: [Account],
  key: Account,
  state: Schema.Struct({
    customerId: Schema.NullOr(CustomerId),
    owner: Schema.NullOr(Schema.String),
    balance: Cents,
    frozen: Schema.Boolean,
  }),
  initial: { customerId: null, owner: null, balance: 0, frozen: false },
  evolve: {
    AccountOpened: (v, e) => ({ ...v, customerId: e.customerId, owner: e.owner }),
    OwnerChanged: (v, e) => ({ ...v, customerId: e.customerId }),
    MoneyDeposited: setBalance,
    MoneyWithdrawn: setBalance,
    TransferDebited: setBalance,
    TransferCredited: setBalance,
    TransferRefunded: setBalance,
    SettlementReceived: setBalance,
    AccountFrozen: (v) => ({ ...v, frozen: true }),
    AccountClosed: () => null,
  },
}) {}
