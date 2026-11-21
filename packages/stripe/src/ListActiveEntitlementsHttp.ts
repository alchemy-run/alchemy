import { GetEntitlementsActiveEntitlements } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { ListActiveEntitlements } from "./ListActiveEntitlements.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link ListActiveEntitlements}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Entitlements
 * @provides Stripe.ListActiveEntitlements
 */
export const ListActiveEntitlementsHttp = Layer.effect(
  ListActiveEntitlements,
  makeHttpStripeAccountBinding({
    tag: "Stripe.ListActiveEntitlements",
    operation: GetEntitlementsActiveEntitlements,
    permissions: ["entitlements_read"],
  }),
);
