import * as Domain from "@alchemy.run/domain";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { TransferId } from "../Transfer/Transfer.id.ts";
import { AccountId } from "./Account.id.ts";
import { InsufficientFunds } from "./InsufficientFunds.rejection.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

export class TransferDebited extends Domain.Event("TransferDebited", {
  transferId: TransferId,
  amount: Cents,
  balanceAfter: Cents,
}) {}

/**
 * Take a transfer's amount out of the source account, if its requester owns
 * it. Sent by `ExecuteTransfer`; the requester is a fact the transfer
 * recorded, so it is input rather than request context.
 */
export class DebitTransfer extends Domain.Command("DebitTransfer", {
  target: AccountId,
  input: { transferId: TransferId, amount: Cents, requestedBy: Actor },
  events: [TransferDebited],
  rejects: [NotOpen, NotOwner, InsufficientFunds],
}) {}
