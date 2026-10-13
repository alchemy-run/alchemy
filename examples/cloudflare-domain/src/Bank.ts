import * as Domain from "alchemy/Domain";
import * as Layer from "effect/Layer";
import { Account } from "./Account/Account.ts";
import { AccountActivity } from "./Account/AccountActivity.ts";
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
import { SettlementRefund, SettlementRefundLive } from "./Settlement/SettlementRefund.ts";
import { AccountTransfers } from "./Transfer/AccountTransfers.ts";
import { Transfer } from "./Transfer/Transfer.ts";
import {
  TransferApprovalDeadline,
  TransferApprovalDeadlineLive,
} from "./Transfer/TransferApprovalDeadline.ts";
import { TransferExecution, TransferExecutionLive } from "./Transfer/TransferExecution.ts";
import { TransferStatus } from "./Transfer/TransferStatus.ts";

/** The bank: every aggregate, view and policy, hosted together. */
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
}) {}

/** The policies' implementations. They require the FraudCheck and Payments external systems. */
export const BankPolicies = Layer.mergeAll(
  UsernameReservationLive,
  MainAccountProvisioningLive,
  TransferExecutionLive,
  TransferApprovalDeadlineLive,
  FraudReviewLive,
  SettlementRefundLive,
);
