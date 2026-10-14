import * as Domain from "alchemy/Domain";
import { TransferId } from "./TransferId.ts";

export class TransferCompleted extends Domain.Event("TransferCompleted", {
  transferId: TransferId,
}) {}

/** Reports an outcome, so it never rejects. */
export class CompleteTransfer extends Domain.Command("CompleteTransfer", {
  target: TransferId,
  events: [TransferCompleted],
}) {}
