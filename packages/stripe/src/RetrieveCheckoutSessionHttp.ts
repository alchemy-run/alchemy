import { GetCheckoutSession } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveCheckoutSession } from "./RetrieveCheckoutSession.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveCheckoutSession}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Checkout
 * @provides Stripe.RetrieveCheckoutSession
 */
export const RetrieveCheckoutSessionHttp = Layer.effect(
  RetrieveCheckoutSession,
  makeHttpStripeAccountBinding({
    tag: "Stripe.RetrieveCheckoutSession",
    operation: GetCheckoutSession,
    permissions: ["checkout_sessions_read"],
  }),
);
