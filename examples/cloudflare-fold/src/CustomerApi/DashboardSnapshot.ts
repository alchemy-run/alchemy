import * as Schema from "effect/Schema";
import { Cents } from "../Money.ts";
import { AccountRow } from "./AccountRow.ts";

/** A customer's home screen. */
export const DashboardSnapshot = Schema.Struct({
  name: Schema.String,
  totalBalance: Cents,
  accounts: Schema.Array(AccountRow),
});
