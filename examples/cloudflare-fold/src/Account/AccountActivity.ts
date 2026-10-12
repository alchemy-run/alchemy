import { View } from "alchemy/Fold";
import { Account } from "./Account.ts";
import { OwnerChanged } from "./ChangeOwner.ts";
import { AccountClosed } from "./CloseAccount.ts";
import { AccountFrozen } from "./FreezeAccount.ts";
import { SettlementOnClosedAccount } from "./RecordSettlement.ts";
import { RefundStranded } from "./RefundTransfer.ts";

/** Operational events for support tooling, passed through unchanged. */
export class AccountActivity extends View.make("AccountActivity", {
  from: [Account],
  key: Account,
  events: [AccountFrozen, AccountClosed, OwnerChanged, RefundStranded, SettlementOnClosedAccount],
}) {}
