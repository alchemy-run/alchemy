import { View } from "alchemy/Fold";
import {
  Account,
  AccountClosed,
  AccountFrozen,
  OwnerChanged,
  RefundStranded,
  SettlementOnClosedAccount,
} from "./Account.ts";

/** Operational events for support tooling, passed through unchanged. */
export class AccountActivity extends View.make("AccountActivity", {
  from: [Account],
  key: Account,
  events: [AccountFrozen, AccountClosed, OwnerChanged, RefundStranded, SettlementOnClosedAccount],
}) {}
