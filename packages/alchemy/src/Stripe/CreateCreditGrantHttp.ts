import { PostBillingCreditGrants } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateCreditGrant } from "./CreateCreditGrant.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateCreditGrant}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateCreditGrant
 */
export const CreateCreditGrantHttp = Layer.effect(
  CreateCreditGrant,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateCreditGrant",
    operation: PostBillingCreditGrants,
    permissions: ["credit_grants_write"],
  }),
);
