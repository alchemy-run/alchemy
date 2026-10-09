import { Mutation } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Account, Deposit, NotOpen, NotOwner } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { customer } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { AccountRow } from "./AccountRow.ts";
import { CurrentCustomer } from "./CurrentCustomer.ts";
import { CustomerSession } from "./CustomerSession.ts";

/** Deposit, then return the account as it is after the deposit (read your own write). */
export class DepositFunds extends Mutation.make("deposit", {
  input: { accountId: AccountId, amount: Cents },
  output: AccountRow,
  errors: [NotOpen, NotOwner],
}).middleware(CustomerSession) {}

export const DepositFundsLive = DepositFunds.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    const summaries = yield* AccountSummary;
    return Effect.fn(function* ({ accountId, amount }) {
      const { customerId } = yield* CurrentCustomer;
      const receipt = yield* accounts.send(
        accountId,
        new Deposit({ amount, by: customer(customerId) }),
      );
      const summary = yield* summaries
        .query(Account.ref(accountId), { atLeast: receipt })
        .pipe(Effect.orDie);
      const v = Option.getOrThrow(summary);
      return { accountId, owner: v.owner ?? "", balance: v.balance, frozen: v.frozen };
    });
  }),
);
