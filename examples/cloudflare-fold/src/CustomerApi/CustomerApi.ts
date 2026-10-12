import { Api } from "alchemy/Fold";
import * as Layer from "effect/Layer";
import { CloseAccount } from "../Account/CloseAccount.ts";
import { DepositMoney } from "../Account/DepositMoney.ts";
import { WithdrawMoney } from "../Account/WithdrawMoney.ts";
import { RegisterCustomer } from "../Customer/RegisterCustomer.ts";
import { RequestTransfer } from "../Transfer/RequestTransfer.ts";
import { AccountWatch, AccountWatchLive } from "./AccountWatch.ts";
import { DashboardFeed, DashboardFeedLive } from "./DashboardFeed.ts";
import { LiveStatement, LiveStatementLive } from "./LiveStatement.ts";
import { StatementHistory, StatementHistoryLive } from "./StatementHistory.ts";
import { TransferLookup, TransferLookupLive } from "./TransferLookup.ts";

/**
 * What customers can do and see. Everything else in the Bank is unreachable
 * from here. Its commands and reads carry `CustomerSession`, so `decide` and
 * the read handlers see the customer as the current actor.
 */
export class CustomerApi extends Api.make(
  RegisterCustomer,
  DepositMoney,
  WithdrawMoney,
  CloseAccount,
  RequestTransfer,
  StatementHistory,
  TransferLookup,
  DashboardFeed,
  AccountWatch,
  LiveStatement,
) {}

/** Handlers for the CustomerApi's reads (commands are implemented by their aggregates). */
export const CustomerApiLive = Layer.mergeAll(
  StatementHistoryLive,
  TransferLookupLive,
  DashboardFeedLive,
  AccountWatchLive,
  LiveStatementLive,
);
