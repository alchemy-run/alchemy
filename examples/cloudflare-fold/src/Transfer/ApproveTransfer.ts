import { Command, Event, Rejection } from "alchemy/Fold";
import { AccountId } from "../Account/AccountId.ts";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { SupportAgentSession } from "../SupportApi/SupportAgentSession.ts";
import { TransferId } from "./TransferId.ts";

/** The transfer is not waiting for approval: it never needed it, or it expired. */
export class NotAwaitingApproval extends Rejection.make("NotAwaitingApproval") {}

/** Carries the transfer so `TransferExecution` can carry it out. */
export class TransferApproved extends Event.make("TransferApproved", {
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
export class ApproveTransfer extends Command.make("ApproveTransfer", {
  target: TransferId,
  events: [TransferApproved],
  rejects: [NotAwaitingApproval],
}).middleware(SupportAgentSession) {}
