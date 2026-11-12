import { GetPromotionCodes } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { ListPromotionCodes } from "./ListPromotionCodes.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link ListPromotionCodes}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product PromotionCode
 * @provides Stripe.ListPromotionCodes
 */
export const ListPromotionCodesHttp = Layer.effect(
  ListPromotionCodes,
  makeHttpStripeAccountBinding({
    tag: "Stripe.ListPromotionCodes",
    operation: GetPromotionCodes,
    permissions: ["promotion_codes_read"],
  }),
);
