import * as Domain from "@alchemy.run/domain";
import { AccountId } from "../Account/Account.id.ts";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { TransferId } from "./Transfer.id.ts";

export class AlreadyRequested extends Domain.Rejection(
  "AlreadyRequested",
  {},
  { httpApiStatus: 409 },
) {}

export class SameAccount extends Domain.Rejection("SameAccount", {}, { httpApiStatus: 400 }) {}

export class TransferRequested extends Domain.Event("TransferRequested", {
  transferId: TransferId,
  from: AccountId,
  to: AccountId,
  amount: Cents,
  requestedBy: Actor,
}) {}

/**
 * Ask to move money between two accounts; `ExecuteTransfer` carries it out
 * on behalf of the requester. The client picks the transfer id, so a retry
 * is idempotent.
 */
export class RequestTransfer extends Domain.Command("RequestTransfer", {
  target: TransferId,
  middleware: [Session],
  input: { from: AccountId, to: AccountId, amount: Cents },
  events: [TransferRequested],
  rejects: [AlreadyRequested, SameAccount],
}) {}
