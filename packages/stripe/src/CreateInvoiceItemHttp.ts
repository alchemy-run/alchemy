import { CreateInvoiceitem } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateInvoiceItem } from "./CreateInvoiceItem.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateInvoiceItem}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Billing
 * @provides Stripe.CreateInvoiceItem
 */
export const CreateInvoiceItemHttp = Layer.effect(
  CreateInvoiceItem,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateInvoiceItem",
    operation: CreateInvoiceitem,
    permissions: ["invoices_write"],
  }),
);
