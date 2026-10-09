import { Port } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Cents } from "../Money.ts";

/** The external payment processor. */
export class Payments extends Port.make("Payments", {
  refund: {
    args: { settlementId: Schema.String, amount: Cents },
    success: { refundId: Schema.String },
  },
}) {}
