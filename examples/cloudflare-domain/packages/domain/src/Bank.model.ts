import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { Account } from "./Account/Account.aggregate.ts";
import { AccountActivity, AccountActivityLive } from "./Account/AccountActivity.view.ts";
import { AccountCard, AccountCardLive } from "./Account/AccountCard.stream.ts";
import { AccountCards, AccountCardsLive } from "./Account/AccountCards.projection.ts";
import { AccountSummary, AccountSummaryLive } from "./Account/AccountSummary.view.ts";
import { Statement, StatementLive } from "./Account/Statement.view.ts";
import { Customer } from "./Customer/Customer.aggregate.ts";
import { CustomerDashboard, CustomerDashboardLive } from "./Customer/CustomerDashboard.view.ts";
import {
  MainAccountProvisioning,
  MainAccountProvisioningLive,
} from "./Customer/MainAccountProvisioning.policy.ts";
import { Registration } from "./Customer/Registration.decision.ts";
import { UsernameClaim } from "./Customer/UsernameClaim.aggregate.ts";
import { DailyOutflow } from "./Fraud/DailyOutflow.view.ts";
import { FraudReview, FraudReviewLive } from "./Fraud/FraudReview.policy.ts";
import { AccountLedger, AccountLedgerLive } from "./Ledger/AccountLedger.query.ts";
import { Ledger, LedgerLive } from "./Ledger/Ledger.projection.ts";
import { SettlementRefund, SettlementRefundLive } from "./Settlement/SettlementRefund.policy.ts";
import { AccountTransfers, AccountTransfersLive } from "./Transfer/AccountTransfers.view.ts";
import { ExecuteTransfer, ExecuteTransferLive } from "./Transfer/ExecuteTransfer.saga.ts";
import { Transfer } from "./Transfer/Transfer.aggregate.ts";
import {
  TransferApprovalDeadline,
  TransferApprovalDeadlineLive,
} from "./Transfer/TransferApprovalDeadline.policy.ts";
import { TransferExecution, TransferExecutionLive } from "./Transfer/TransferExecution.policy.ts";
import { TransferStatus, TransferStatusLive } from "./Transfer/TransferStatus.view.ts";

/** The bank: every aggregate, decision, view, policy, projection, stream, saga and query, hosted together. */
export class Bank extends Domain.Model("Bank", {
  aggregates: [Customer, UsernameClaim, Account, Transfer],
  decisions: [Registration],
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
    MainAccountProvisioning,
    TransferExecution,
    TransferApprovalDeadline,
    FraudReview,
    SettlementRefund,
  ],
  projections: [Ledger, AccountCards],
  streams: [AccountCard],
  sagas: [ExecuteTransfer],
  queries: [AccountLedger],
  relations: {
    /** Whoever a username is claimed for is registered under it. */
    AClaimedNameBelongsToItsCustomer: Domain.Relation({
      over: { customer: Customer, claim: UsernameClaim },
      holds: ({ customer, claim }) =>
        claim.state._tag !== "Claimed" ||
        claim.state.customerId !== customer.id ||
        (customer.state._tag === "Registered" && customer.state.username === claim.id),
    }),
    /** A registered customer holds the username they registered under. */
    ARegisteredCustomerHoldsTheirName: Domain.Relation({
      over: { customer: Customer, claim: UsernameClaim },
      holds: ({ customer, claim }) =>
        customer.state._tag !== "Registered" ||
        customer.state.username !== claim.id ||
        (claim.state._tag === "Claimed" && claim.state.customerId === customer.id),
    }),
  },
  invariants: {
    /** Every cent a transfer takes out of an account is paid into another, paid back, or recorded as stranded. */
    TransfersLoseNoMoney: (bank) => {
      const events = bank.Account.flatMap((account) => account.events);
      const sum = (amounts: ReadonlyArray<number>) =>
        amounts.reduce((total, amount) => total + amount, 0);
      const taken = sum(
        events.flatMap((event) => (event._tag === "TransferDebited" ? [event.amount] : [])),
      );
      const given = sum(
        events.flatMap((event) =>
          event._tag === "TransferCredited" ||
          event._tag === "TransferRefunded" ||
          event._tag === "RefundStranded"
            ? [event.amount]
            : [],
        ),
      );
      return taken === given;
    },
    /** A transfer that may run has run: it completed or it failed. */
    NoTransferLeftPending: (bank) =>
      bank.Transfer.every((transfer) => transfer.state._tag !== "Pending"),
    /** The ledger is given every deposit the accounts record. */
    LedgerIsGivenEveryDeposit: (bank) =>
      bank.Ledger.filter((row) => row.event._tag === "MoneyDeposited").length ===
      bank.Account.flatMap((account) => account.events).filter(
        (event) => event._tag === "MoneyDeposited",
      ).length,
  },
  eventually: {
    /** No transfer waits for ever: one nobody approves expires. */
    EveryTransferEnds: (bank) =>
      bank.Transfer.every(
        (transfer) => transfer.state._tag === "Completed" || transfer.state._tag === "Failed",
      ),
  },
}) {}

/** Who may read each key: the `validate` of every guarded view and stream. */
export const BankReads = Layer.mergeAll(
  AccountSummaryLive,
  CustomerDashboardLive,
  StatementLive,
  AccountActivityLive,
  TransferStatusLive,
  AccountTransfersLive,
  AccountCardLive,
);

/**
 * The policies', projections' and queries' implementations, and who may read
 * each key. They require the FraudCheck and Payments external systems, and
 * the LedgerStore.
 */
export const BankHandlers = Layer.mergeAll(
  BankReads,
  MainAccountProvisioningLive,
  TransferExecutionLive,
  ExecuteTransferLive,
  TransferApprovalDeadlineLive,
  FraudReviewLive,
  SettlementRefundLive,
  LedgerLive,
  AccountLedgerLive,
  AccountCardsLive,
);
