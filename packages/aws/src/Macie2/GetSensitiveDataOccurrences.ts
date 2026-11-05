import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `macie2:GetSensitiveDataOccurrences`.
 *
 * Retrieves occurrences of sensitive data reported by a finding.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetSensitiveDataOccurrencesHttp)`.
 * ### Retrieving Sensitive Data Samples
 * **Example:** Retrieve Samples for a Finding
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSensitiveDataOccurrences = yield* AWS.Macie2.GetSensitiveDataOccurrences();
 *
 * // runtime
 * const { sensitiveDataOccurrences } = yield* getSensitiveDataOccurrences({ findingId });
 * ```
 *
 * @binding
 */
export interface GetSensitiveDataOccurrences extends Binding.Service<
  GetSensitiveDataOccurrences,
  "AWS.Macie2.GetSensitiveDataOccurrences",
  () => Effect.Effect<
    (
      request: macie2.GetSensitiveDataOccurrencesRequest,
    ) => Effect.Effect<
      macie2.GetSensitiveDataOccurrencesResponse,
      macie2.GetSensitiveDataOccurrencesError
    >
  >
> {}
export const GetSensitiveDataOccurrences = Binding.Service<GetSensitiveDataOccurrences>(
  "AWS.Macie2.GetSensitiveDataOccurrences",
);

export const GetSensitiveDataOccurrencesHttp = Layer.effect(
  GetSensitiveDataOccurrences,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetSensitiveDataOccurrences",
    operation: macie2.getSensitiveDataOccurrences,
    actions: ["macie2:GetSensitiveDataOccurrences"],
  }),
);
