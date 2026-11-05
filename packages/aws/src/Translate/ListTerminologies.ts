import * as translate from "@distilled.cloud/aws/translate";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTranslateHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `translate:ListTerminologies` — list the custom
 * terminologies in the account and region.
 *
 * ### Reading Terminologies
 * **Example:** List terminologies
 * ```typescript
 * // init
 * const listTerminologies = yield* AWS.Translate.ListTerminologies();
 *
 * // runtime
 * const result = yield* listTerminologies({ MaxResults: 50 });
 * // result.TerminologyPropertiesList -> [{ Name, Arn, TermCount, … }, …]
 * ```
 *
 * @binding
 */
export interface ListTerminologies extends Binding.Service<
  ListTerminologies,
  "AWS.Translate.ListTerminologies",
  () => Effect.Effect<
    (
      request?: translate.ListTerminologiesRequest,
    ) => Effect.Effect<translate.ListTerminologiesResponse, translate.ListTerminologiesError>
  >
> {}
export const ListTerminologies = Binding.Service<ListTerminologies>(
  "AWS.Translate.ListTerminologies",
);

export const ListTerminologiesHttp = Layer.effect(
  ListTerminologies,
  makeTranslateHttpBinding({
    tag: "AWS.Translate.ListTerminologies",
    operation: translate.listTerminologies,
    actions: ["translate:ListTerminologies"],
  }),
);
