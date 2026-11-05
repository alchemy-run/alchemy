import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `macie2:GetFindings`.
 *
 * Retrieves the details of one or more findings.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetFindingsHttp)`.
 * ### Working with Findings
 * **Example:** Hydrate Finding Details
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getFindings = yield* AWS.Macie2.GetFindings();
 *
 * // runtime
 * const { findings } = yield* getFindings({ findingIds });
 * ```
 *
 * @binding
 */
export interface GetFindings extends Binding.Service<
  GetFindings,
  "AWS.Macie2.GetFindings",
  () => Effect.Effect<
    (
      request?: macie2.GetFindingsRequest,
    ) => Effect.Effect<macie2.GetFindingsResponse, macie2.GetFindingsError>
  >
> {}
export const GetFindings = Binding.Service<GetFindings>("AWS.Macie2.GetFindings");

export const GetFindingsHttp = Layer.effect(
  GetFindings,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetFindings",
    operation: macie2.getFindings,
    actions: ["macie2:GetFindings"],
  }),
);
