import { Api } from "alchemy/Fold";
import * as Layer from "effect/Layer";
import { AccountWatch, AccountWatchLive } from "./AccountWatch.ts";
import { DashboardFeed, DashboardFeedLive } from "./DashboardFeed.ts";
import { DepositFunds, DepositFundsLive } from "./DepositFunds.ts";
import { LiveStatement, LiveStatementLive } from "./LiveStatement.ts";
import { RegisterCustomer, RegisterCustomerLive } from "./RegisterCustomer.ts";
import { StatementHistory, StatementHistoryLive } from "./StatementHistory.ts";
import { TransferFunds, TransferFundsLive } from "./TransferFunds.ts";
import { TransferLookup, TransferLookupLive } from "./TransferLookup.ts";
import { WithdrawFunds, WithdrawFundsLive } from "./WithdrawFunds.ts";

/**
 * What customers can do and see. Everything else in the Bank is unreachable
 * from here. Each operation carries its own `CustomerSession`, so its handler
 * may read `CurrentCustomer`.
 */
export class CustomerApi extends Api.make(
  RegisterCustomer,
  DepositFunds,
  WithdrawFunds,
  TransferFunds,
  StatementHistory,
  TransferLookup,
  DashboardFeed,
  AccountWatch,
  LiveStatement,
) {}

/** Server-side implementations of every CustomerApi operation (middleware Layers are provided separately). */
export const CustomerApiLive = Layer.mergeAll(
  RegisterCustomerLive,
  DepositFundsLive,
  WithdrawFundsLive,
  TransferFundsLive,
  StatementHistoryLive,
  TransferLookupLive,
  DashboardFeedLive,
  AccountWatchLive,
  LiveStatementLive,
);
