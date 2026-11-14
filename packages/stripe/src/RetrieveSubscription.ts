import type {
  GetSubscriptionError,
  GetSubscriptionRequest,
  Subscription,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Retrieve a Stripe Subscription by id over HTTP. Account-scoped — binds
 * the API key onto the host, not a specific resource.
 *
 * ### Reading a Subscription
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieveSubscription = yield* Stripe.RetrieveSubscription();
 * const subscription = yield* retrieveSubscription({
 *   subscription_exposed_id: subscriptionId,
 * });
 * ```
 *
 * @binding
 * @product Billing
 */
export interface RetrieveSubscription extends Binding.Service<
  RetrieveSubscription,
  "Stripe.RetrieveSubscription",
  () => Effect.Effect<
    (
      request: GetSubscriptionRequest,
    ) => Effect.Effect<Subscription, GetSubscriptionError, RuntimeContext>
  >
> {}

export const RetrieveSubscription = Binding.Service<RetrieveSubscription>(
  "Stripe.RetrieveSubscription",
);
