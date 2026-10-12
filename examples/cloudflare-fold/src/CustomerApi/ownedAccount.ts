import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Account } from "../Account/Account.ts";
import type { AccountId } from "../Account/AccountId.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { NotOwner } from "../Account/NotOwner.ts";
import { currentCustomerId } from "../CurrentActor.ts";

/**
 * Builds an ownership check: the signed-in customer's account, or `NotOwner`
 * (also when it does not exist). Resolve it while building a handler; each
 * call needs only the request's CurrentActor.
 */
export const makeOwnedAccount = Effect.gen(function* () {
  const summaries = yield* AccountSummary;
  return Effect.fn(function* (accountId: AccountId) {
    const customerId = yield* currentCustomerId;
    const summary = yield* summaries.query(Account.ref(accountId)).pipe(Effect.orDie);
    if (Option.isNone(summary) || summary.value.customerId !== customerId)
      return yield* new NotOwner();
    return summary.value;
  });
});
