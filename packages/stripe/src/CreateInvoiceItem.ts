import type {
  CreateInvoiceitemError,
  CreateInvoiceitemRequest,
  Invoiceitem,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Create a Stripe Invoice Item over HTTP: a one-off charge that goes on
 * the customer's next invoice. Account-scoped — binds the API key onto the
 * host, not a specific resource.
 *
 * ### Adding a one-off charge
 * **Example:** Bind and charge
 * ```typescript
 * const createInvoiceItem = yield* Stripe.CreateInvoiceItem();
 * yield* createInvoiceItem({
 *   customer: customerId,
 *   amount: 500,
 *   currency: "usd",
 *   description: "Setup fee",
 * });
 * ```
 *
 * @binding
 * @product Billing
 */
export interface CreateInvoiceItem extends Binding.Service<
  CreateInvoiceItem,
  "Stripe.CreateInvoiceItem",
  () => Effect.Effect<
    (
      request: CreateInvoiceitemRequest,
    ) => Effect.Effect<Invoiceitem, CreateInvoiceitemError, RuntimeContext>
  >
> {}

export const CreateInvoiceItem = Binding.Service<CreateInvoiceItem>("Stripe.CreateInvoiceItem");
