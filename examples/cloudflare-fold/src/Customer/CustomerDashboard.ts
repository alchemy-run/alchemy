import { View } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/AccountId.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { Cents } from "../Money.ts";
import { Customer } from "./Customer.ts";

/**
 * A customer's accounts and balances. Consumes AccountSummary changes and
 * re-keys them by customer, so an ownership change moves the account between
 * dashboards.
 */
export class CustomerDashboard extends View.make("CustomerDashboard", {
  from: [Customer, AccountSummary],
  key: Customer,
  keyOf: {
    AccountSummary: (s) => (s.customerId ? Customer.ref(s.customerId) : undefined),
  },
  state: Schema.Struct({
    name: Schema.NullOr(Schema.String),
    balances: Schema.Record(AccountId, Cents),
  }),
  initial: { name: null, balances: {} },
  evolve: {
    CustomerRegistered: (d, e) => ({ ...d, name: e.name }),
    AccountSummary: (d, { source, after }) => {
      const { [source.id]: _removed, ...rest } = d.balances;
      return { ...d, balances: after ? { ...rest, [source.id]: after.balance } : rest };
    },
  },
  computed: {
    totalBalance: (d) => Object.values<number>(d.balances).reduce((a, b) => a + b, 0),
  },
}) {}
