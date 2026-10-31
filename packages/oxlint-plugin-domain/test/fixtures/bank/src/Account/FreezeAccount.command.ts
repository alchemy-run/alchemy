import * as Domain from "@alchemy.run/domain";
import { AccountId } from "./Account.id.ts";
import { Frozen } from "./Frozen.rejection.ts";

export class AccountFrozen extends Domain.Event("AccountFrozen", {}) {}

export class FreezeAccount extends Domain.Command("FreezeAccount", {
  target: AccountId,
  events: [AccountFrozen],
  rejects: [Frozen],
}) {}
