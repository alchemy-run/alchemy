import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `auditmanager:ValidateAssessmentReportIntegrity`.
 *
 * Validates the integrity (checksums) of a generated assessment
 * report in Amazon S3. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ValidateAssessmentReportIntegrityHttp)`.
 * ### Assessment Reports
 * **Example:** Validate a Generated Report
 * ```typescript
 * const validateAssessmentReportIntegrity = yield* AWS.AuditManager.ValidateAssessmentReportIntegrity();
 * const result = yield* validateAssessmentReportIntegrity({ s3RelativePath: "s3://audit-reports/report.zip" });
 * ```
 *
 * @binding
 */
export interface ValidateAssessmentReportIntegrity extends Binding.Service<
  ValidateAssessmentReportIntegrity,
  "AWS.AuditManager.ValidateAssessmentReportIntegrity",
  () => Effect.Effect<
    (
      request: auditmanager.ValidateAssessmentReportIntegrityRequest,
    ) => Effect.Effect<
      auditmanager.ValidateAssessmentReportIntegrityResponse,
      auditmanager.ValidateAssessmentReportIntegrityError
    >
  >
> {}

export const ValidateAssessmentReportIntegrity = Binding.Service<ValidateAssessmentReportIntegrity>(
  "AWS.AuditManager.ValidateAssessmentReportIntegrity",
);

export const ValidateAssessmentReportIntegrityHttp = Layer.effect(
  ValidateAssessmentReportIntegrity,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.ValidateAssessmentReportIntegrity",
    operation: auditmanager.validateAssessmentReportIntegrity,
    actions: ["auditmanager:ValidateAssessmentReportIntegrity"],
  }),
);
