import * as Domain from "alchemy/Domain";
import * as Layer from "effect/Layer";
import { Account } from "./Account/Account.ts";
import { AccountActivity } from "./Account/AccountActivity.ts";
import { AccountCard } from "./Account/AccountCard.ts";
import { AccountCards, AccountCardsLive } from "./Account/AccountCards.ts";
import { AccountSummary } from "./Account/AccountSummary.ts";
import { Statement } from "./Account/Statement.ts";
import { Customer } from "./Customer/Customer.ts";
import { CustomerDashboard } from "./Customer/CustomerDashboard.ts";
import {
  MainAccountProvisioning,
  MainAccountProvisioningLive,
} from "./Customer/MainAccountProvisioning.ts";
import { UsernameClaim } from "./Customer/UsernameClaim.ts";
import { UsernameReservation, UsernameReservationLive } from "./Customer/UsernameReservation.ts";
import { DailyOutflow } from "./Fraud/DailyOutflow.ts";
import { FraudReview, FraudReviewLive } from "./Fraud/FraudReview.ts";
import { Ledger } from "./Ledger/Ledger.ts";
import { LedgerLive } from "./Ledger/LedgerLive.ts";
import { SettlementRefund, SettlementRefundLive } from "./Settlement/SettlementRefund.ts";
import { AccountTransfers } from "./Transfer/AccountTransfers.ts";
import { ExecuteTransfer, ExecuteTransferLive } from "./Transfer/ExecuteTransfer.ts";
import { Transfer } from "./Transfer/Transfer.ts";
import {
  TransferApprovalDeadline,
  TransferApprovalDeadlineLive,
} from "./Transfer/TransferApprovalDeadline.ts";
import { TransferExecution, TransferExecutionLive } from "./Transfer/TransferExecution.ts";
import { TransferStatus } from "./Transfer/TransferStatus.ts";

/** The bank: every aggregate, view, policy, projection, stream and saga, hosted together. */
export class Bank extends Domain.Model("Bank", {
  aggregates: [Customer, UsernameClaim, Account, Transfer],
  views: [
    AccountSummary,
    CustomerDashboard,
    Statement,
    AccountActivity,
    TransferStatus,
    AccountTransfers,
    DailyOutflow,
  ],
  policies: [
    UsernameReservation,
    MainAccountProvisioning,
    TransferExecution,
    TransferApprovalDeadline,
    FraudReview,
    SettlementRefund,
  ],
  projections: [Ledger, AccountCards],
  streams: [AccountCard],
  sagas: [ExecuteTransfer],
}) {}

/**
 * The policies' and projections' implementations. They require the FraudCheck
 * and Payments external systems, and the LedgerStore.
 */
export const BankHandlers = Layer.mergeAll(
  UsernameReservationLive,
  MainAccountProvisioningLive,
  TransferExecutionLive,
  ExecuteTransferLive,
  TransferApprovalDeadlineLive,
  FraudReviewLive,
  SettlementRefundLive,
  LedgerLive,
  AccountCardsLive,
);
