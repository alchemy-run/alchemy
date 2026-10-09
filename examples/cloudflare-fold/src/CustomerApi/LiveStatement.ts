import { Subscription } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Account, NotOwner } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { Statement } from "../Account/Statement.ts";
import { CustomerSession } from "./CustomerSession.ts";
import { makeOwnedAccount } from "./ownedAccount.ts";
import { StatementEntry, toStatementEntry } from "./StatementEntry.ts";

/** An account's statement, live: past entries, then new ones as they happen. */
export class LiveStatement extends Subscription.make("statementLive", {
  input: { accountId: AccountId },
  output: StatementEntry,
  errors: [NotOwner],
}).middleware(CustomerSession) {}

export const LiveStatementLive = LiveStatement.toLayer(
  Effect.gen(function* () {
    const statement = yield* Statement;
    const ownedAccount = yield* makeOwnedAccount;
    return Effect.fn(function* ({ accountId }) {
      yield* ownedAccount(accountId); // fails before streaming
      return statement.events(Account.ref(accountId)).pipe(Stream.map(toStatementEntry));
    });
  }),
);
