import { PostIssuingCardsCard } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";
import { UpdateIssuingCard } from "./UpdateIssuingCard.ts";

/**
 * HTTP implementation of {@link UpdateIssuingCard}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.UpdateIssuingCard
 */
export const UpdateIssuingCardHttp = Layer.effect(
  UpdateIssuingCard,
  makeHttpStripeIdBinding({
    tag: "Stripe.UpdateIssuingCard",
    operation: PostIssuingCardsCard,
    idField: "card",
  }),
);
