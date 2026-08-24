import { GetEntitlementsFeaturesId } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveEntitlementsFeature } from "./RetrieveEntitlementsFeature.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveEntitlementsFeature}.
 *
 * @layer
 * @provides Stripe.RetrieveEntitlementsFeature
 */
export const RetrieveEntitlementsFeatureHttp = Layer.effect(
  RetrieveEntitlementsFeature,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveEntitlementsFeature",
    operation: GetEntitlementsFeaturesId,
    idField: "id",
    permissions: ["entitlements_read"],
  }),
);
