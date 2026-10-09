import { Mutation } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import {
  Account,
  DailyLimitExceeded,
  Frozen,
  InsufficientFunds,
  NotOpen,
  NotOwner,
  Withdraw,
} from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { customer } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { CurrentCustomer } from "./CurrentCustomer.ts";
import { CustomerSession } from "./CustomerSession.ts";
import { MfaChallenge } from "./MfaChallenge.ts";

/** Withdraw money. Ownership is enforced by the Account aggregate. */
export class WithdrawFunds extends Mutation.make("withdraw", {
  input: { accountId: AccountId, amount: Cents },
  output: { balance: Cents },
  errors: [NotOpen, NotOwner, Frozen, InsufficientFunds, DailyLimitExceeded],
})
  .middleware(CustomerSession)
  .middleware(MfaChallenge) {}

export const WithdrawFundsLive = WithdrawFunds.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ accountId, amount }) {
      const { customerId } = yield* CurrentCustomer;
      const { reply } = yield* accounts.send(
        accountId,
        new Withdraw({ amount, by: customer(customerId) }),
      );
      return reply;
    });
  }),
);
