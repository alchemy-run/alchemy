import type {
  IssuingCardholder as StripeIssuingCardholder,
  PostIssuingCardholdersCardholderError,
  PostIssuingCardholdersCardholderRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { IssuingCardholder } from "./IssuingCardholder.ts";

export interface UpdateIssuingCardholderRequest extends Omit<
  PostIssuingCardholdersCardholderRequest,
  "cardholder"
> {}

/**
 * Update a bound Stripe Issuing Cardholder over HTTP.
 *
 * ### Updating a Cardholder
 * **Example:** Bind and update
 * ```typescript
 * const update = yield* Stripe.UpdateIssuingCardholder(alice);
 * const live = yield* update({ email: "alice@example.com" });
 * ```
 *
 * @binding
 */
export interface UpdateIssuingCardholder extends Binding.Service<
  UpdateIssuingCardholder,
  "Stripe.UpdateIssuingCardholder",
  (
    cardholder: IssuingCardholder,
  ) => Effect.Effect<
    (
      request?: UpdateIssuingCardholderRequest,
    ) => Effect.Effect<
      StripeIssuingCardholder,
      PostIssuingCardholdersCardholderError,
      RuntimeContext
    >
  >
> {}

export const UpdateIssuingCardholder = Binding.Service<UpdateIssuingCardholder>(
  "Stripe.UpdateIssuingCardholder",
);
