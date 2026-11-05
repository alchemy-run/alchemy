import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Assessment } from "./Assessment.ts";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";

/** `GetEvidenceFoldersByAssessment` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface GetEvidenceFoldersByAssessmentRequest extends Omit<
  auditmanager.GetEvidenceFoldersByAssessmentRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:GetEvidenceFoldersByAssessment`.
 *
 * Lists the evidence folders in the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetEvidenceFoldersByAssessmentHttp)`.
 * ### Reading Evidence
 * **Example:** List the Assessment's Evidence Folders
 * ```typescript
 * const getEvidenceFoldersByAssessment = yield* AWS.AuditManager.GetEvidenceFoldersByAssessment(assessment);
 * const result = yield* getEvidenceFoldersByAssessment({ maxResults: 20 });
 * ```
 *
 * @binding
 */
export interface GetEvidenceFoldersByAssessment extends Binding.Service<
  GetEvidenceFoldersByAssessment,
  "AWS.AuditManager.GetEvidenceFoldersByAssessment",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request?: GetEvidenceFoldersByAssessmentRequest,
    ) => Effect.Effect<
      auditmanager.GetEvidenceFoldersByAssessmentResponse,
      auditmanager.GetEvidenceFoldersByAssessmentError
    >
  >
> {}

export const GetEvidenceFoldersByAssessment = Binding.Service<GetEvidenceFoldersByAssessment>(
  "AWS.AuditManager.GetEvidenceFoldersByAssessment",
);

export const GetEvidenceFoldersByAssessmentHttp = Layer.effect(
  GetEvidenceFoldersByAssessment,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.GetEvidenceFoldersByAssessment",
    operation: auditmanager.getEvidenceFoldersByAssessment,
    actions: ["auditmanager:GetEvidenceFoldersByAssessment"],
  }),
);
