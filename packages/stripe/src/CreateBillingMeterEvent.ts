import type {
  CreateBillingMeterEvent2Error,
  CreateBillingMeterEventRequest2,
  V2BillingMeterEvent,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Report usage to a Stripe Billing Meter over HTTP (`POST
 * /v2/billing/meter_events`: synchronous validation, up to 1,000 events
 * per second in livemode). Account-scoped — binds the API key onto the
 * host, not a specific resource.
 *
 * ### Reporting usage
 * **Example:** Bind and report
 * ```typescript
 * const recordUsage = yield* Stripe.CreateBillingMeterEvent();
 * yield* recordUsage({
 *   event_name: "api_requests",
 *   identifier: requestId,
 *   payload: { stripe_customer_id: customerId, value: "1" },
 * });
 * ```
 *
 * @binding
 * @product Billing
 */
export interface CreateBillingMeterEvent extends Binding.Service<
  CreateBillingMeterEvent,
  "Stripe.CreateBillingMeterEvent",
  () => Effect.Effect<
    (
      request: CreateBillingMeterEventRequest2,
    ) => Effect.Effect<V2BillingMeterEvent, CreateBillingMeterEvent2Error, RuntimeContext>
  >
> {}

export const CreateBillingMeterEvent = Binding.Service<CreateBillingMeterEvent>(
  "Stripe.CreateBillingMeterEvent",
);
