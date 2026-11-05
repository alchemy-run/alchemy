import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Assessment } from "./Assessment.ts";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";

/** `GetEvidenceFolder` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface GetEvidenceFolderRequest extends Omit<
  auditmanager.GetEvidenceFolderRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:GetEvidenceFolder`.
 *
 * Gets an evidence folder from the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetEvidenceFolderHttp)`.
 * ### Reading Evidence
 * **Example:** Get an Evidence Folder
 * ```typescript
 * const getEvidenceFolder = yield* AWS.AuditManager.GetEvidenceFolder(assessment);
 * const result = yield* getEvidenceFolder({ controlSetId, evidenceFolderId });
 * ```
 *
 * @binding
 */
export interface GetEvidenceFolder extends Binding.Service<
  GetEvidenceFolder,
  "AWS.AuditManager.GetEvidenceFolder",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: GetEvidenceFolderRequest,
    ) => Effect.Effect<auditmanager.GetEvidenceFolderResponse, auditmanager.GetEvidenceFolderError>
  >
> {}

export const GetEvidenceFolder = Binding.Service<GetEvidenceFolder>(
  "AWS.AuditManager.GetEvidenceFolder",
);

export const GetEvidenceFolderHttp = Layer.effect(
  GetEvidenceFolder,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.GetEvidenceFolder",
    operation: auditmanager.getEvidenceFolder,
    actions: ["auditmanager:GetEvidenceFolder"],
  }),
);
