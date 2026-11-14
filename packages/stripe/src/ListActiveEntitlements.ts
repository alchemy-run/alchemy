import type {
  GetEntitlementsActiveEntitlementsError,
  GetEntitlementsActiveEntitlementsRequest,
  GetEntitlementsActiveEntitlementsResponse,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * List the active entitlements of a Stripe Customer over HTTP: the
 * features their subscriptions give them now. Account-scoped — binds the
 * API key onto the host, not a specific resource.
 *
 * ### Gating a feature
 * **Example:** Bind and check
 * ```typescript
 * const listEntitlements = yield* Stripe.ListActiveEntitlements();
 * const page = yield* listEntitlements({ customer: customerId });
 * const canExport = page.data.some((e) => e.lookup_key === "export");
 * ```
 *
 * @binding
 * @product Entitlements
 */
export interface ListActiveEntitlements extends Binding.Service<
  ListActiveEntitlements,
  "Stripe.ListActiveEntitlements",
  () => Effect.Effect<
    (
      request: GetEntitlementsActiveEntitlementsRequest,
    ) => Effect.Effect<
      GetEntitlementsActiveEntitlementsResponse,
      GetEntitlementsActiveEntitlementsError,
      RuntimeContext
    >
  >
> {}

export const ListActiveEntitlements = Binding.Service<ListActiveEntitlements>(
  "Stripe.ListActiveEntitlements",
);
