import { PostIssuingCardholdersCardholder } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";
import { UpdateIssuingCardholder } from "./UpdateIssuingCardholder.ts";

/**
 * HTTP implementation of {@link UpdateIssuingCardholder}. Provide it on
 * the Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.UpdateIssuingCardholder
 */
export const UpdateIssuingCardholderHttp = Layer.effect(
  UpdateIssuingCardholder,
  makeHttpStripeIdBinding({
    tag: "Stripe.UpdateIssuingCardholder",
    operation: PostIssuingCardholdersCardholder,
    idField: "cardholder",
  }),
);
