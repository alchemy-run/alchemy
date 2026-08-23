import { GetProductsId } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveProduct } from "./RetrieveProduct.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveProduct}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveProduct
 */
export const RetrieveProductHttp = Layer.effect(
  RetrieveProduct,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveProduct",
    operation: GetProductsId,
    idField: "id",
  }),
);
