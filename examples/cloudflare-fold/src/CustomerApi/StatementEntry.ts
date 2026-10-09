import * as Schema from "effect/Schema";
import { Cents } from "../Money.ts";

/** One movement of money, as shown to the account owner. */
export const StatementEntry = Schema.Struct({
  at: Schema.DateTimeUtc,
  kind: Schema.String,
  amount: Cents,
  balance: Cents,
});
