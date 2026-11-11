import * as Domain from "@alchemy.run/domain";
import { Account } from "../../src/Account/Account.aggregate.ts";
import { Customer } from "../../src/Customer/Customer.aggregate.ts";
import { MainAccountProvisioning } from "../../src/Customer/MainAccountProvisioning.policy.ts";
import { UsernameClaim } from "../../src/Customer/UsernameClaim.aggregate.ts";
import { UsernameReservation } from "../../src/Customer/UsernameReservation.policy.ts";
import { ExecuteTransfer } from "../../src/Transfer/ExecuteTransfer.saga.ts";
import { Transfer } from "../../src/Transfer/Transfer.aggregate.ts";
import { TransferApprovalDeadline } from "../../src/Transfer/TransferApprovalDeadline.policy.ts";
import { TransferExecution } from "../../src/Transfer/TransferExecution.policy.ts";

/** The bank's aggregates, policies and saga, with two rules the bank does not keep. */
export class Careless extends Domain.Model("Careless", {
  aggregates: [Customer, UsernameClaim, Account, Transfer],
  policies: [
    UsernameReservation,
    MainAccountProvisioning,
    TransferExecution,
    TransferApprovalDeadline,
  ],
  sagas: [ExecuteTransfer],
  invariants: {
    /** Forgets that a transfer whose credit is refused gives the money back. */
    EveryDebitIsCredited: (bank) => {
      const events = bank.Account.flatMap((account) => account.events);
      const sum = (amounts: ReadonlyArray<number>) =>
        amounts.reduce((total, amount) => total + amount, 0);
      return (
        sum(events.flatMap((event) => (event._tag === "TransferDebited" ? [event.amount] : []))) ===
        sum(events.flatMap((event) => (event._tag === "TransferCredited" ? [event.amount] : [])))
      );
    },
    NoTransferFails: (bank) => bank.Transfer.every((transfer) => transfer.state._tag !== "Failed"),
    HoldsAtMostTenDollars: (bank) =>
      bank.Account.reduce(
        (total, account) => total + (account.state._tag === "Open" ? account.state.balance : 0),
        0,
      ) <= 1000,
  },
}) {}
