import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `auditmanager:ListAssessmentReports`.
 *
 * Lists the assessment reports created in the account. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ListAssessmentReportsHttp)`.
 * ### Assessment Reports
 * **Example:** List Assessment Reports
 * ```typescript
 * const listAssessmentReports = yield* AWS.AuditManager.ListAssessmentReports();
 * const result = yield* listAssessmentReports({ maxResults: 20 });
 * ```
 *
 * @binding
 */
export interface ListAssessmentReports extends Binding.Service<
  ListAssessmentReports,
  "AWS.AuditManager.ListAssessmentReports",
  () => Effect.Effect<
    (
      request?: auditmanager.ListAssessmentReportsRequest,
    ) => Effect.Effect<
      auditmanager.ListAssessmentReportsResponse,
      auditmanager.ListAssessmentReportsError
    >
  >
> {}

export const ListAssessmentReports = Binding.Service<ListAssessmentReports>(
  "AWS.AuditManager.ListAssessmentReports",
);

export const ListAssessmentReportsHttp = Layer.effect(
  ListAssessmentReports,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.ListAssessmentReports",
    operation: auditmanager.listAssessmentReports,
    actions: ["auditmanager:ListAssessmentReports"],
  }),
);
