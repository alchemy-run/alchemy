import { CreateBillingMeterEvent2 } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateBillingMeterEvent } from "./CreateBillingMeterEvent.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateBillingMeterEvent}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Billing
 * @provides Stripe.CreateBillingMeterEvent
 */
export const CreateBillingMeterEventHttp = Layer.effect(
  CreateBillingMeterEvent,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateBillingMeterEvent",
    operation: CreateBillingMeterEvent2,
    permissions: ["billing_meter_events_write"],
  }),
);
