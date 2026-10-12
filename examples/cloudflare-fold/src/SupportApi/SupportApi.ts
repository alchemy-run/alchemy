import { Api } from "alchemy/Fold";
import { AccountActivity } from "../Account/AccountActivity.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { ChangeOwner } from "../Account/ChangeOwner.ts";
import { FreezeAccount } from "../Account/FreezeAccount.ts";
import { ApproveTransfer } from "../Transfer/ApproveTransfer.ts";

/** What the support console reaches, over the same Bank. */
export class SupportApi extends Api.make(
  "SupportApi",
  FreezeAccount,
  ChangeOwner,
  ApproveTransfer,
  AccountSummary,
  AccountActivity,
) {}
