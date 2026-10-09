import { View } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/AccountId.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { Cents } from "../Money.ts";
import { Customer } from "./Customer.ts";

type Balances = Readonly<Record<AccountId, number>>;

const without = (balances: Balances, id: AccountId): Balances => {
  const { [id]: _removed, ...rest } = balances;
  return rest;
};

/**
 * A customer's accounts and balances, built from AccountSummary's events and
 * the summary after each. An ownership change moves the account between
 * dashboards.
 */
export class CustomerDashboard extends View.make("CustomerDashboard", {
  from: [Customer, AccountSummary],
  key: Customer,
  keyOf: {
    AccountSummary: ({ state }) => (state?.customerId ? Customer.ref(state.customerId) : undefined),
    OwnerChanged: {
      previous: ({ event }) => Customer.ref(event.previous),
      current: ({ event }) => Customer.ref(event.customerId),
    },
  },
  state: Schema.Struct({
    name: Schema.NullOr(Schema.String),
    balances: Schema.Record(AccountId, Cents),
  }),
  initial: { name: null, balances: {} },
  evolve: {
    CustomerRegistered: (d, e) => ({ ...d, name: e.name }),
    OwnerChanged: {
      previous: (d, _, { source }) => ({ ...d, balances: without(d.balances, source.id) }),
      current: (d, _, { source, state }) => ({
        ...d,
        balances: { ...d.balances, [source.id]: state?.balance ?? 0 },
      }),
    },
    AccountSummary: (d, _, { source, state }) => ({
      ...d,
      balances:
        state && !state.closed
          ? { ...d.balances, [source.id]: state.balance }
          : without(d.balances, source.id),
    }),
  },
  computed: {
    totalBalance: (d) => Object.values<number>(d.balances).reduce((a, b) => a + b, 0),
  },
}) {}
