import type { View } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import type { Statement } from "../Account/Statement.ts";
import { Cents } from "../Money.ts";

/** One movement of money, as shown to the account owner. */
export const StatementEntry = Schema.Struct({
  at: Schema.DateTimeUtc,
  kind: Schema.String,
  amount: Cents,
  balance: Cents,
});

/** A statement line as the Api shows it: the line plus when it happened. */
export const toStatementEntry = ({
  event,
  envelope,
}: View.Entry<View.StateOf<typeof Statement>, View.EventOf<typeof Statement>>) => ({
  at: envelope.at,
  kind: event.kind,
  amount: event.amount,
  balance: event.balance,
});
