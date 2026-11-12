import type {
  CreateSubscriptionError,
  CreateSubscriptionRequest,
  Subscription,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Create a Stripe Subscription over HTTP. Account-scoped — binds the API
 * key onto the host, not a specific resource.
 *
 * ### Subscribing a customer to a price
 * **Example:** Bind and subscribe
 * ```typescript
 * const createSubscription = yield* Stripe.CreateSubscription();
 * const subscription = yield* createSubscription({
 *   customer: customerId,
 *   items: [{ price: priceId }],
 * });
 * ```
 *
 * @binding
 * @product Billing
 */
export interface CreateSubscription extends Binding.Service<
  CreateSubscription,
  "Stripe.CreateSubscription",
  () => Effect.Effect<
    (
      request: CreateSubscriptionRequest,
    ) => Effect.Effect<Subscription, CreateSubscriptionError, RuntimeContext>
  >
> {}

export const CreateSubscription = Binding.Service<CreateSubscription>("Stripe.CreateSubscription");
