import type {
  CreateSubscriptionItemError,
  CreateSubscriptionItemRequest,
  SubscriptionItem,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Add an item (a price) to an existing Stripe Subscription over HTTP.
 * Account-scoped — binds the API key onto the host, not a specific
 * resource.
 *
 * ### Adding an add-on to a subscription
 * **Example:** Bind and add an item
 * ```typescript
 * const createItem = yield* Stripe.CreateSubscriptionItem();
 * yield* createItem({
 *   subscription: subscriptionId,
 *   price: addOnPriceId,
 *   quantity: 1,
 * });
 * ```
 *
 * @binding
 * @product Billing
 */
export interface CreateSubscriptionItem extends Binding.Service<
  CreateSubscriptionItem,
  "Stripe.CreateSubscriptionItem",
  () => Effect.Effect<
    (
      request: CreateSubscriptionItemRequest,
    ) => Effect.Effect<SubscriptionItem, CreateSubscriptionItemError, RuntimeContext>
  >
> {}

export const CreateSubscriptionItem = Binding.Service<CreateSubscriptionItem>(
  "Stripe.CreateSubscriptionItem",
);
