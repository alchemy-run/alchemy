import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class RefundDeclined extends Schema.TaggedErrorClass<RefundDeclined>()("RefundDeclined", {
  reason: Schema.String,
}) {}
export class ChargeDeclined extends Schema.TaggedErrorClass<ChargeDeclined>()(
  "ChargeDeclined",
  {},
) {}

export class Payments extends Domain.ExternalSystem("Payments", {
  refund: {
    args: { settlementId: Schema.String },
    success: { refundId: Schema.String },
    error: RefundDeclined,
  },
  charge: {
    args: { amount: Schema.Int },
    success: { chargeId: Schema.String },
    error: ChargeDeclined,
  },
}) {}
