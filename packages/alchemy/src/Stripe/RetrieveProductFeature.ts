import type {
  GetProductsProductFeaturesIdError,
  GetProductsProductFeaturesIdRequest,
  ProductFeature as StripeProductFeature,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ProductFeature } from "./ProductFeature.ts";

export interface RetrieveProductFeatureRequest extends Omit<
  GetProductsProductFeaturesIdRequest,
  "id" | "product"
> {}

/**
 * Retrieve a bound Stripe Product Feature attachment over HTTP.
 *
 * ### Reading a Product Feature
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveProductFeature(seatsOnPro);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveProductFeature extends Binding.Service<
  RetrieveProductFeature,
  "Stripe.RetrieveProductFeature",
  (
    productFeature: ProductFeature,
  ) => Effect.Effect<
    (
      request?: RetrieveProductFeatureRequest,
    ) => Effect.Effect<
      StripeProductFeature,
      GetProductsProductFeaturesIdError,
      RuntimeContext
    >
  >
> {}

export const RetrieveProductFeature = Binding.Service<RetrieveProductFeature>(
  "Stripe.RetrieveProductFeature",
);
