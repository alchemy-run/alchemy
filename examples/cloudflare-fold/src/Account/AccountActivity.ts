import { Feed } from "alchemy/Fold";
import {
  Account,
  AccountClosed,
  AccountFrozen,
  OwnerChanged,
  RefundStranded,
  SettlementOnClosedAccount,
} from "./Account.ts";

/** Raw operational events for support tooling. */
export class AccountActivity extends Feed.make("AccountActivity", {
  from: [Account],
  key: Account,
  events: [AccountFrozen, AccountClosed, OwnerChanged, RefundStranded, SettlementOnClosedAccount],
}) {}
