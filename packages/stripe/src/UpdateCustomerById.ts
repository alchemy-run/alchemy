import type {
  Customer as StripeCustomer,
  UpdateCustomerError,
  UpdateCustomerRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Update any Stripe Customer over HTTP, by the id in the request. Use it for
 * customers made at runtime (one per tenant or user); {@link UpdateCustomer}
 * binds one Customer resource of the stack. Account-scoped — binds the API
 * key onto the host.
 *
 * ### Setting a customer's default card
 * **Example:** Bind and update
 * ```typescript
 * const updateCustomer = yield* Stripe.UpdateCustomerById();
 * yield* updateCustomer({
 *   customer: customerId,
 *   invoice_settings: { default_payment_method: paymentMethodId },
 * });
 * ```
 *
 * @binding
 * @product Customer
 */
export interface UpdateCustomerById extends Binding.Service<
  UpdateCustomerById,
  "Stripe.UpdateCustomerById",
  () => Effect.Effect<
    (
      request: UpdateCustomerRequest,
    ) => Effect.Effect<StripeCustomer, UpdateCustomerError, RuntimeContext>
  >
> {}

export const UpdateCustomerById = Binding.Service<UpdateCustomerById>("Stripe.UpdateCustomerById");
