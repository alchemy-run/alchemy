import * as Domain from "alchemy/Domain";
import * as Schema from "effect/Schema";
import { TransferId } from "./TransferId.ts";

export class TransferFailed extends Domain.Event("TransferFailed", {
  data: { transferId: TransferId, reason: Schema.String },
}) {}

/** Reports an outcome, so it never rejects. */
export class FailTransfer extends Domain.Command("FailTransfer", {
  target: TransferId,
  input: { reason: Schema.String },
  events: [TransferFailed],
}) {}
