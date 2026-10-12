import * as Effect from "effect/Effect";
import { Payments } from "./Payments.ts";

/**
 * A stand-in adapter for a payment processor. Swap it for a Stripe HTTP
 * adapter in production.
 */
export const StripePayments = Payments.toLayer(
  Effect.succeed({
    refund: ({ settlementId }) => Effect.succeed({ refundId: `re_${settlementId}` }),
  }),
);
