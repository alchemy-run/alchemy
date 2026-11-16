import type {
  GetPromotionCodesError,
  GetPromotionCodesRequest,
  GetPromotionCodesResponse,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * List Stripe Promotion Codes over HTTP, for example to resolve the code a
 * customer typed. Account-scoped — binds the API key onto the host, not a
 * specific promotion code.
 *
 * ### Resolving a typed code
 * **Example:** Bind and list
 * ```typescript
 * const listPromotionCodes = yield* Stripe.ListPromotionCodes();
 * const page = yield* listPromotionCodes({ code: "SPRING", active: true, limit: 1 });
 * ```
 *
 * @binding
 * @product PromotionCode
 */
export interface ListPromotionCodes extends Binding.Service<
  ListPromotionCodes,
  "Stripe.ListPromotionCodes",
  () => Effect.Effect<
    (
      request: GetPromotionCodesRequest,
    ) => Effect.Effect<GetPromotionCodesResponse, GetPromotionCodesError, RuntimeContext>
  >
> {}

export const ListPromotionCodes = Binding.Service<ListPromotionCodes>("Stripe.ListPromotionCodes");
