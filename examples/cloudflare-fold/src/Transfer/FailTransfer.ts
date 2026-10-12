import { Command, Event } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { TransferId } from "./TransferId.ts";

export class TransferFailed extends Event.make("TransferFailed", {
  data: { transferId: TransferId, reason: Schema.String },
}) {}

/** Reports an outcome, so it never rejects. */
export class FailTransfer extends Command.make("FailTransfer", {
  input: { reason: Schema.String },
  events: [TransferFailed],
}) {}
