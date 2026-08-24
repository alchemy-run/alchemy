import { GetPricesPrice } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrievePrice } from "./RetrievePrice.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrievePrice}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrievePrice
 */
export const RetrievePriceHttp = Layer.effect(
  RetrievePrice,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrievePrice",
    operation: GetPricesPrice,
    idField: "price",
    permissions: ["prices_read"],
  }),
);
