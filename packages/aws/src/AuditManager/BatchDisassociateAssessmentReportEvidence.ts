import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Assessment } from "./Assessment.ts";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";

/** `BatchDisassociateAssessmentReportEvidence` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface BatchDisassociateAssessmentReportEvidenceRequest extends Omit<
  auditmanager.BatchDisassociateAssessmentReportEvidenceRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:BatchDisassociateAssessmentReportEvidence`.
 *
 * Removes a batch of evidence items from the (in-progress)
 * assessment report of the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.BatchDisassociateAssessmentReportEvidenceHttp)`.
 * ### Assessment Reports
 * **Example:** Exclude a Batch of Evidence from the Report
 * ```typescript
 * const batchDisassociateAssessmentReportEvidence = yield* AWS.AuditManager.BatchDisassociateAssessmentReportEvidence(assessment);
 * const result = yield* batchDisassociateAssessmentReportEvidence({ evidenceFolderId, evidenceIds });
 * ```
 *
 * @binding
 */
export interface BatchDisassociateAssessmentReportEvidence extends Binding.Service<
  BatchDisassociateAssessmentReportEvidence,
  "AWS.AuditManager.BatchDisassociateAssessmentReportEvidence",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: BatchDisassociateAssessmentReportEvidenceRequest,
    ) => Effect.Effect<
      auditmanager.BatchDisassociateAssessmentReportEvidenceResponse,
      auditmanager.BatchDisassociateAssessmentReportEvidenceError
    >
  >
> {}

export const BatchDisassociateAssessmentReportEvidence =
  Binding.Service<BatchDisassociateAssessmentReportEvidence>(
    "AWS.AuditManager.BatchDisassociateAssessmentReportEvidence",
  );

export const BatchDisassociateAssessmentReportEvidenceHttp = Layer.effect(
  BatchDisassociateAssessmentReportEvidence,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.BatchDisassociateAssessmentReportEvidence",
    operation: auditmanager.batchDisassociateAssessmentReportEvidence,
    actions: ["auditmanager:BatchDisassociateAssessmentReportEvidence"],
  }),
);
