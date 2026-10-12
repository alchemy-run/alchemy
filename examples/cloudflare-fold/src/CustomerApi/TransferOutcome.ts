import * as Schema from "effect/Schema";
import { TransferId } from "../Transfer/TransferId.ts";

/** Where a transfer stands. */
export const TransferOutcome = Schema.Struct({
  transferId: TransferId,
  status: Schema.Literals(["pending", "awaiting-approval", "in-flight", "completed", "failed"]),
  reason: Schema.NullOr(Schema.String),
});
