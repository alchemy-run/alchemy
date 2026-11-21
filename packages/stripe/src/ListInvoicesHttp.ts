import { GetInvoices } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { ListInvoices } from "./ListInvoices.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link ListInvoices}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Billing
 * @provides Stripe.ListInvoices
 */
export const ListInvoicesHttp = Layer.effect(
  ListInvoices,
  makeHttpStripeAccountBinding({
    tag: "Stripe.ListInvoices",
    operation: GetInvoices,
    permissions: ["invoices_read"],
  }),
);
