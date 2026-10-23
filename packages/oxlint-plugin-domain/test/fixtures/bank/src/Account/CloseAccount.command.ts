import * as Domain from "@alchemy.run/domain";
import { AccountId } from "./Account.id.ts";

export class AccountClosed extends Domain.Event("AccountClosed", {}) {}

/** Never rejects. */
export class CloseAccount extends Domain.Command("CloseAccount", {
  target: AccountId,
  events: [AccountClosed],
}) {}
