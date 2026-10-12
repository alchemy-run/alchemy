import * as Domain from "alchemy/Domain";
import { AccountId } from "../Account/AccountId.ts";
import { NotPermitted } from "../Account/ChangeOwner.ts";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.ts";
import { TransferId } from "./TransferId.ts";

/** The transfer is not waiting for approval: it never needed it, or it expired. */
export class NotAwaitingApproval extends Domain.Rejection("NotAwaitingApproval") {}

/** Carries the transfer so `TransferExecution` can carry it out. */
export class TransferApproved extends Domain.Event("TransferApproved", {
  data: {
    transferId: TransferId,
    from: AccountId,
    to: AccountId,
    amount: Cents,
    requestedBy: Actor,
    approvedBy: Actor,
  },
}) {}

/** A support agent approves a large transfer before its approval window closes. */
export class ApproveTransfer extends Domain.Command("ApproveTransfer", {
  target: TransferId,
  middleware: [Session],
  events: [TransferApproved],
  rejects: [NotAwaitingApproval, NotPermitted],
}) {}
