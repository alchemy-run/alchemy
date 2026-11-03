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
  row: LedgerRow,
  from: [Ledger],
  middleware: [Session],
  rejects: [NotOwner],
  take: { default: 50, max: 200 },
  attributes: ({ account }) => ({ "bank.account": account }),
  validate: Effect.fn(function* ({ account }) {
    const summaries = yield* AccountSummary;
    const summary = yield* summaries.query(Account.ref(account)).pipe(Effect.orDie);
    yield* mustOwn(Option.getOrNull(summary)?.customerId ?? null);
  }),
}) {}

/** Reads the page from the ledger store, keyed by the account `validate` allowed. */
export const AccountLedgerLive = AccountLedger.toLayer(
  Effect.gen(function* () {
    const store = yield* LedgerStore;
    return ({ account }, page) => store.forAccount(account, page);
  }),
);
