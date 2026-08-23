import { GetPaymentMethodDomainsPaymentMethodDomain } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrievePaymentMethodDomain } from "./RetrievePaymentMethodDomain.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrievePaymentMethodDomain}.
 *
 * @layer
 * @provides Stripe.RetrievePaymentMethodDomain
 */
export const RetrievePaymentMethodDomainHttp = Layer.effect(
  RetrievePaymentMethodDomain,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrievePaymentMethodDomain",
    operation: GetPaymentMethodDomainsPaymentMethodDomain,
    idField: "payment_method_domain",
  }),
);
