import * as Domain from "alchemy/Domain";
import * as Schema from "effect/Schema";
import { Cents } from "../Money.ts";

/** The external payment processor. */
export class Payments extends Domain.ExternalSystem("Payments", {
  refund: {
    args: { settlementId: Schema.String, amount: Cents },
    success: { refundId: Schema.String },
  },
}) {}
