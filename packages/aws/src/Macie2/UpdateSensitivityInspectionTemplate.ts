import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `macie2:UpdateSensitivityInspectionTemplate`.
 *
 * Updates the settings for the sensitivity inspection template for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.UpdateSensitivityInspectionTemplateHttp)`.
 * ### Automated Discovery
 * **Example:** Tune the Inspection Template
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateSensitivityInspectionTemplate = yield* AWS.Macie2.UpdateSensitivityInspectionTemplate();
 *
 * // runtime
 * yield* updateSensitivityInspectionTemplate({
 *   id: templateId,
 *   includes: { managedDataIdentifierIds: ["CREDIT_CARD_NUMBER"] },
 * });
 * ```
 *
 * @binding
 */
export interface UpdateSensitivityInspectionTemplate extends Binding.Service<
  UpdateSensitivityInspectionTemplate,
  "AWS.Macie2.UpdateSensitivityInspectionTemplate",
  () => Effect.Effect<
    (
      request: macie2.UpdateSensitivityInspectionTemplateRequest,
    ) => Effect.Effect<
      macie2.UpdateSensitivityInspectionTemplateResponse,
      macie2.UpdateSensitivityInspectionTemplateError
    >
  >
> {}
export const UpdateSensitivityInspectionTemplate =
  Binding.Service<UpdateSensitivityInspectionTemplate>(
    "AWS.Macie2.UpdateSensitivityInspectionTemplate",
  );

export const UpdateSensitivityInspectionTemplateHttp = Layer.effect(
  UpdateSensitivityInspectionTemplate,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.UpdateSensitivityInspectionTemplate",
    operation: macie2.updateSensitivityInspectionTemplate,
    actions: ["macie2:UpdateSensitivityInspectionTemplate"],
  }),
);
