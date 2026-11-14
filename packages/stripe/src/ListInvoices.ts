import type {
  GetInvoicesError,
  GetInvoicesRequest,
  GetInvoicesResponse,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * List Stripe Invoices over HTTP, for example the invoices of one
 * customer. Account-scoped — binds the API key onto the host, not a
 * specific resource.
 *
 * ### Listing a customer's invoices
 * **Example:** Bind and list
 * ```typescript
 * const listInvoices = yield* Stripe.ListInvoices();
 * const page = yield* listInvoices({ customer: customerId, limit: 10 });
 * // page.data, page.has_more
 * ```
 *
 * @binding
 * @product Billing
 */
export interface ListInvoices extends Binding.Service<
  ListInvoices,
  "Stripe.ListInvoices",
  () => Effect.Effect<
    (
      request: GetInvoicesRequest,
    ) => Effect.Effect<GetInvoicesResponse, GetInvoicesError, RuntimeContext>
  >
> {}

export const ListInvoices = Binding.Service<ListInvoices>("Stripe.ListInvoices");
