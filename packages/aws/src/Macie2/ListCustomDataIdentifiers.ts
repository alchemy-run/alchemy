import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `macie2:ListCustomDataIdentifiers`.
 *
 * Retrieves a subset of information about the custom data identifiers for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListCustomDataIdentifiersHttp)`.
 * ### Custom Data Identifiers & Lists
 * **Example:** List Custom Data Identifiers
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listCustomDataIdentifiers = yield* AWS.Macie2.ListCustomDataIdentifiers();
 *
 * // runtime
 * const { items } = yield* listCustomDataIdentifiers();
 * ```
 *
 * @binding
 */
export interface ListCustomDataIdentifiers extends Binding.Service<
  ListCustomDataIdentifiers,
  "AWS.Macie2.ListCustomDataIdentifiers",
  () => Effect.Effect<
    (
      request?: macie2.ListCustomDataIdentifiersRequest,
    ) => Effect.Effect<
      macie2.ListCustomDataIdentifiersResponse,
      macie2.ListCustomDataIdentifiersError
    >
  >
> {}
export const ListCustomDataIdentifiers = Binding.Service<ListCustomDataIdentifiers>(
  "AWS.Macie2.ListCustomDataIdentifiers",
);

export const ListCustomDataIdentifiersHttp = Layer.effect(
  ListCustomDataIdentifiers,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.ListCustomDataIdentifiers",
    operation: macie2.listCustomDataIdentifiers,
    actions: ["macie2:ListCustomDataIdentifiers"],
  }),
);
