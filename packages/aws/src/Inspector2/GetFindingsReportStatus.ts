import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `inspector2:GetFindingsReportStatus`.
 *
 * Gets the status of a findings report.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetFindingsReportStatusHttp)`.
 * ### Findings Reports & SBOM Exports
 * **Example:** Poll a Findings Report
 * ```typescript
 * // init
 * const getFindingsReportStatus = yield* AWS.Inspector2.GetFindingsReportStatus();
 *
 * // runtime
 * const { status } = yield* getFindingsReportStatus({ reportId });
 * ```
 *
 * @binding
 */
export interface GetFindingsReportStatus extends Binding.Service<
  GetFindingsReportStatus,
  "AWS.Inspector2.GetFindingsReportStatus",
  () => Effect.Effect<
    (
      request?: inspector2.GetFindingsReportStatusRequest,
    ) => Effect.Effect<
      inspector2.GetFindingsReportStatusResponse,
      inspector2.GetFindingsReportStatusError
    >
  >
> {}
export const GetFindingsReportStatus = Binding.Service<GetFindingsReportStatus>(
  "AWS.Inspector2.GetFindingsReportStatus",
);

export const GetFindingsReportStatusHttp = Layer.effect(
  GetFindingsReportStatus,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.GetFindingsReportStatus",
    operation: inspector2.getFindingsReportStatus,
    actions: ["inspector2:GetFindingsReportStatus"],
  }),
);
