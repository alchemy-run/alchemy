import * as Domain from "alchemy/Domain";
import { AccountActivity } from "./Account/AccountActivity.view.ts";
import { AccountSummary } from "./Account/AccountSummary.view.ts";
import { ChangeOwner } from "./Account/ChangeOwner.command.ts";
import { FreezeAccount } from "./Account/FreezeAccount.command.ts";
import { ApproveTransfer } from "./Transfer/ApproveTransfer.command.ts";

/** What the support console reaches, over the same Bank. */
export class SupportApi extends Domain.Api(
  "SupportApi",
  FreezeAccount,
  ChangeOwner,
  ApproveTransfer,
  AccountSummary,
  AccountActivity,
) {}
