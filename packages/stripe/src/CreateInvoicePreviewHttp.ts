import { CreateInvoicesCreatePreview } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateInvoicePreview } from "./CreateInvoicePreview.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateInvoicePreview}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Billing
 * @provides Stripe.CreateInvoicePreview
 */
export const CreateInvoicePreviewHttp = Layer.effect(
  CreateInvoicePreview,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateInvoicePreview",
    operation: CreateInvoicesCreatePreview,
    permissions: ["invoices_read"],
  }),
);
