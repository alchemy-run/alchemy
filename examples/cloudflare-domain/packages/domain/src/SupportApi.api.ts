import * as Domain from "@alchemy.run/domain";
import { AccountActivity } from "./Account/AccountActivity.view.ts";
import { AccountSummary } from "./Account/AccountSummary.view.ts";
import { ChangeOwner } from "./Account/ChangeOwner.command.ts";
import { FreezeAccount } from "./Account/FreezeAccount.command.ts";
import { Bank } from "./Bank.model.ts";
import { ApproveTransfer } from "./Transfer/ApproveTransfer.command.ts";

/** What the support console reaches, over the same Bank. */
export class SupportApi extends Domain.Api("SupportApi", {
  model: Bank,
  serves: [FreezeAccount, ChangeOwner, ApproveTransfer, AccountSummary, AccountActivity],
}) {}
