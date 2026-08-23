import type {
  BillingMeter as StripeBillingMeter,
  GetBillingMetersIdError,
  GetBillingMetersIdRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { BillingMeter } from "./BillingMeter.ts";

export interface RetrieveBillingMeterRequest extends Omit<
  GetBillingMetersIdRequest,
  "id"
> {}

/**
 * Retrieve a bound Stripe Billing Meter over HTTP.
 *
 * ### Reading a Billing Meter
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveBillingMeter(usage);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveBillingMeter extends Binding.Service<
  RetrieveBillingMeter,
  "Stripe.RetrieveBillingMeter",
  (
    meter: BillingMeter,
  ) => Effect.Effect<
    (
      request?: RetrieveBillingMeterRequest,
    ) => Effect.Effect<
      StripeBillingMeter,
      GetBillingMetersIdError,
      RuntimeContext
    >
  >
> {}

export const RetrieveBillingMeter = Binding.Service<RetrieveBillingMeter>(
  "Stripe.RetrieveBillingMeter",
);
