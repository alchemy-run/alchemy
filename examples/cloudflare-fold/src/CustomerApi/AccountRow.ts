import * as Schema from "effect/Schema";
import { AccountId } from "../Account/AccountId.ts";
import { Cents } from "../Money.ts";

/** One account as shown to its owner. */
export const AccountRow = Schema.Struct({
  accountId: AccountId,
  owner: Schema.String,
  balance: Cents,
  frozen: Schema.Boolean,
});
export type AccountRow = typeof AccountRow.Type;
