import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { Account } from "./Account/Account.aggregate.ts";
import { AccountSummary, AccountSummaryLive } from "./Account/AccountSummary.view.ts";
import { ExecuteTransfer, ExecuteTransferLive } from "./Transfer/ExecuteTransfer.saga.ts";
import { Transfer } from "./Transfer/Transfer.aggregate.ts";
import { TransferExecution, TransferExecutionLive } from "./Transfer/TransferExecution.policy.ts";
import { TransferStatus, TransferStatusLive } from "./Transfer/TransferStatus.view.ts";

/** The bank: accounts, transfers between them, and the views that read them. */
export class Bank extends Domain.Model("Bank", {
  aggregates: [Account, Transfer],
  views: [AccountSummary, TransferStatus],
  policies: [TransferExecution],
  sagas: [ExecuteTransfer],
}) {}

/** The policy's and saga's implementations, and who may read each view key. */
export const BankHandlers = Layer.mergeAll(
  AccountSummaryLive,
  TransferStatusLive,
  TransferExecutionLive,
  ExecuteTransferLive,
);
