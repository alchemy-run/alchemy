import type {
  CheckoutSession,
  GetCheckoutSessionError,
  GetCheckoutSessionRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Retrieve a Stripe Checkout Session over HTTP by id, for example after the
 * customer returns from a hosted checkout. Account-scoped — binds the API
 * key onto the host, not a specific session.
 *
 * ### Reading a returned session
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieveSession = yield* Stripe.RetrieveCheckoutSession();
 * const session = yield* retrieveSession({ session: "cs_test_…", expand: ["setup_intent"] });
 * ```
 *
 * @binding
 * @product Checkout
 */
export interface RetrieveCheckoutSession extends Binding.Service<
  RetrieveCheckoutSession,
  "Stripe.RetrieveCheckoutSession",
  () => Effect.Effect<
    (
      request: GetCheckoutSessionRequest,
    ) => Effect.Effect<CheckoutSession, GetCheckoutSessionError, RuntimeContext>
  >
> {}

export const RetrieveCheckoutSession = Binding.Service<RetrieveCheckoutSession>(
  "Stripe.RetrieveCheckoutSession",
);
