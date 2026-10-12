import { Command, Event } from "alchemy/Fold";
import { TransferId } from "./TransferId.ts";

export class TransferCompleted extends Event.make("TransferCompleted", {
  data: { transferId: TransferId },
}) {}

/** Reports an outcome, so it never rejects. */
export class CompleteTransfer extends Command.make("CompleteTransfer", {
  target: TransferId,
  events: [TransferCompleted],
}) {}
