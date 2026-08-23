import type {
  FileLink as StripeFileLink,
  PostFileLinksError,
  PostFileLinksRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * Create a Stripe File Link over HTTP. Account-scoped — binds the API key
 * onto the host, not a specific file link resource.
 *
 * ### Creating a File Link at runtime
 * **Example:** Bind and create
 * ```typescript
 * const create = yield* Stripe.CreateFileLink();
 * const link = yield* create({
 *   file: "file_123",
 * });
 * ```
 *
 * @binding
 */
export interface CreateFileLink extends Binding.Service<
  CreateFileLink,
  "Stripe.CreateFileLink",
  () => Effect.Effect<
    (
      request: PostFileLinksRequest,
    ) => Effect.Effect<StripeFileLink, PostFileLinksError, RuntimeContext>
  >
> {}

export const CreateFileLink = Binding.Service<CreateFileLink>(
  "Stripe.CreateFileLink",
);
