import type {
  Subscription,
  UpdateSubscriptionError,
  UpdateSubscriptionRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Update a Stripe Subscription by id over HTTP (change items, cancel at
 * period end, …). Account-scoped — binds the API key onto the host, not a
 * specific resource.
 *
 * ### Cancelling at the end of the period
 * **Example:** Bind and update
 * ```typescript
 * const updateSubscription = yield* Stripe.UpdateSubscription();
 * yield* updateSubscription({
 *   subscription_exposed_id: subscriptionId,
 *   cancel_at_period_end: true,
 * });
 * ```
 *
 * @binding
 * @product Billing
 */
export interface UpdateSubscription extends Binding.Service<
  UpdateSubscription,
  "Stripe.UpdateSubscription",
  () => Effect.Effect<
    (
      request: UpdateSubscriptionRequest,
    ) => Effect.Effect<Subscription, UpdateSubscriptionError, RuntimeContext>
  >
> {}

export const UpdateSubscription = Binding.Service<UpdateSubscription>("Stripe.UpdateSubscription");
