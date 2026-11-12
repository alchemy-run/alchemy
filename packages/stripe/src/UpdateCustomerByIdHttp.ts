import { UpdateCustomer as updateCustomerOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";
import { UpdateCustomerById } from "./UpdateCustomerById.ts";

/**
 * HTTP implementation of {@link UpdateCustomerById}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Customer
 * @provides Stripe.UpdateCustomerById
 */
export const UpdateCustomerByIdHttp = Layer.effect(
  UpdateCustomerById,
  makeHttpStripeAccountBinding({
    tag: "Stripe.UpdateCustomerById",
    operation: updateCustomerOp,
    permissions: ["customers_write"],
  }),
);
