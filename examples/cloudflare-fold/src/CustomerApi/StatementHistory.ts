import { Query } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Account, NotOwner } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { Statement } from "../Account/Statement.ts";
import { Cents } from "../Money.ts";
import { CustomerSession } from "./CustomerSession.ts";
import { makeOwnedAccount } from "./ownedAccount.ts";
import { StatementEntry, toStatementEntry } from "./StatementEntry.ts";

/** A page of an account's statement, newest first. */
export class StatementHistory extends Query.make("statement", {
  input: {
    accountId: AccountId,
    minAmount: Schema.optional(Cents),
    cursor: Schema.optional(Schema.String),
  },
  output: Schema.Struct({
    entries: Schema.Array(StatementEntry),
    cursor: Schema.NullOr(Schema.String),
  }),
  errors: [NotOwner],
}).middleware(CustomerSession) {}

export const StatementHistoryLive = StatementHistory.toLayer(
  Effect.gen(function* () {
    const statement = yield* Statement;
    const ownedAccount = yield* makeOwnedAccount;
    return Effect.fn(function* ({ accountId, minAmount, cursor }) {
      yield* ownedAccount(accountId);
      const page = yield* statement.list(Account.ref(accountId), {
        where: { amount: { gte: minAmount ?? 0 } },
        order: "desc",
        take: 50,
        after: cursor,
      });
      return { entries: page.entries.map(toStatementEntry), cursor: page.cursor };
    });
  }),
);
