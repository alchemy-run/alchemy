import type {
  GetProductsIdError,
  GetProductsIdRequest,
  Product as StripeProduct,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Product } from "./Product.ts";

export interface RetrieveProductRequest extends Omit<
  GetProductsIdRequest,
  "id"
> {}

/**
 * Retrieve a bound Stripe Product over HTTP.
 *
 * ### Reading a Product
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveProduct(product);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveProduct extends Binding.Service<
  RetrieveProduct,
  "Stripe.RetrieveProduct",
  (
    product: Product,
  ) => Effect.Effect<
    (
      request?: RetrieveProductRequest,
    ) => Effect.Effect<StripeProduct, GetProductsIdError, RuntimeContext>
  >
> {}

export const RetrieveProduct = Binding.Service<RetrieveProduct>(
  "Stripe.RetrieveProduct",
);
