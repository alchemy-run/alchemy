import { Subscription } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Account } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { Customer } from "../Customer/Customer.ts";
import { CustomerDashboard } from "../Customer/CustomerDashboard.ts";
import { CurrentCustomer } from "./CurrentCustomer.ts";
import { CustomerSession } from "./CustomerSession.ts";
import { DashboardSnapshot } from "./DashboardSnapshot.ts";

/** The signed-in customer's home screen, live. */
export class DashboardFeed extends Subscription.make("dashboard", {
  output: DashboardSnapshot,
}).middleware(CustomerSession) {}

export const DashboardFeedLive = DashboardFeed.toLayer(
  Effect.gen(function* () {
    const dashboards = yield* CustomerDashboard;
    const summaries = yield* AccountSummary;
    return Effect.fn(function* () {
      const { customerId } = yield* CurrentCustomer;
      const dashboard = dashboards.watch(Customer.ref(customerId)).pipe(
        Stream.filter(Option.isSome),
        Stream.map((d) => d.value),
      );
      return summaries
        .watchEach(
          dashboard,
          (d) => Object.keys(d.balances).map((id) => Account.ref(AccountId.make(id))),
          {
            where: { customerId }, // row security, evaluated where the view lives
          },
        )
        .pipe(
          Stream.map(([d, accounts]) => ({
            name: d.name ?? "",
            totalBalance: CustomerDashboard.computed.totalBalance(d),
            accounts: accounts.map(([ref, a]) => ({
              accountId: ref.id,
              owner: a.owner ?? "",
              balance: a.balance,
              frozen: a.frozen,
            })),
          })),
        );
    });
  }),
);
