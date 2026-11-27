import type {
  CreateInvoicesCreatePreviewError,
  CreateInvoicesCreatePreviewRequest,
  Invoice,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Preview the next Stripe Invoice (`POST /v1/invoices/create_preview`)
 * over HTTP. Stripe maps this call to the invoice read permission: it
 * creates no invoice. Account-scoped — binds the API key onto the host,
 * not a specific resource.
 *
 * ### Showing the price of a plan change
 * **Example:** Bind and preview
 * ```typescript
 * const previewInvoice = yield* Stripe.CreateInvoicePreview();
 * const preview = yield* previewInvoice({
 *   customer: customerId,
 *   subscription: subscriptionId,
 *   subscription_details: { items: [{ id: itemId, price: newPriceId }] },
 * });
 * // preview.amount_due
 * ```
 *
 * @binding
 * @product Billing
 */
export interface CreateInvoicePreview extends Binding.Service<
  CreateInvoicePreview,
  "Stripe.CreateInvoicePreview",
  () => Effect.Effect<
    (
      request: CreateInvoicesCreatePreviewRequest,
    ) => Effect.Effect<Invoice, CreateInvoicesCreatePreviewError, RuntimeContext>
  >
> {}

export const CreateInvoicePreview = Binding.Service<CreateInvoicePreview>(
  "Stripe.CreateInvoicePreview",
);
