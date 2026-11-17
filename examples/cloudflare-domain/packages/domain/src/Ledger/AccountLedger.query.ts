import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Account } from "../Account/Account.aggregate.ts";
import { AccountId } from "../Account/Account.id.ts";
import { AccountSummary } from "../Account/AccountSummary.view.ts";
import { mustOwn } from "../Account/mustOwn.ts";
import { NotOwner } from "../Account/NotOwner.rejection.ts";
import { Session } from "../Session.middleware.ts";
import { Ledger } from "./Ledger.projection.ts";
import { LedgerRow, LedgerStore } from "./LedgerStore.ts";

/**
 * An account's movements from the ledger table, a page at a time. The same
 * people may read it as may read the account: its owner, or any agent.
 */
export class AccountLedger extends Domain.Query("AccountLedger", {
  input: { account: AccountId },
  success: LedgerRow,
  paged: true,
  waitsFor: [Ledger],
  middleware: [Session],
  rejects: [NotOwner],
}) {}

/** Checks the caller may read the account, then reads its page from the ledger store. */
export const AccountLedgerLive = AccountLedger.toLayer(
  Effect.gen(function* () {
    const store = yield* LedgerStore;
    const summaries = yield* AccountSummary;
    return Effect.fn(function* ({ account }, page) {
      yield* Effect.annotateCurrentSpan("bank.account", account);
      const summary = yield* summaries.get(Account.ref(account)).pipe(Effect.orDie);
      yield* mustOwn(Option.getOrNull(summary)?.customerId ?? null);
      return yield* store.forAccount(account, page);
    });
  }),
  { take: { default: 50, max: 200 } },
);
