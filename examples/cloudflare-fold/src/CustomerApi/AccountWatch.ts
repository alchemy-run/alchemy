import { Subscription } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Account, NotOwner } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { AccountRow } from "./AccountRow.ts";
import { CurrentCustomer } from "./CurrentCustomer.ts";
import { CustomerSession } from "./CustomerSession.ts";

/** One account, live. Ends with `NotOwner` if the account is reassigned away. */
export class AccountWatch extends Subscription.make("account", {
  input: { accountId: AccountId },
  output: AccountRow,
  errors: [NotOwner],
}).middleware(CustomerSession) {}

export const AccountWatchLive = AccountWatch.toLayer(
  Effect.gen(function* () {
    const summaries = yield* AccountSummary;
    return Effect.fn(function* ({ accountId }) {
      const { customerId } = yield* CurrentCustomer;
      return summaries.watch(Account.ref(accountId), { where: { customerId } }).pipe(
        Stream.mapEffect(
          Option.match({
            onNone: () => Effect.fail(new NotOwner()),
            onSome: (a) =>
              Effect.succeed({
                accountId,
                owner: a.owner ?? "",
                balance: a.balance,
                frozen: a.frozen,
              }),
          }),
        ),
      );
    });
  }),
);
