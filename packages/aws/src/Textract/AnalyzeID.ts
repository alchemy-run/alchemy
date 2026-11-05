import * as textract from "@distilled.cloud/aws/textract";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `textract:AnalyzeID` — synchronous extraction of
 * identity-document fields (name, date of birth, document number, …) from
 * images of passports, driver licenses, and other government IDs.
 *
 * ### Synchronous Analysis
 * **Example:** Analyze an Identity Document
 * ```typescript
 * // init
 * const analyzeID = yield* AWS.Textract.AnalyzeID();
 *
 * // runtime
 * const result = yield* analyzeID({
 *   DocumentPages: [{ Bytes: licenseBytes }],
 * });
 * const fields = result.IdentityDocuments?.[0]?.IdentityDocumentFields;
 * ```
 *
 * @binding
 */
export interface AnalyzeID extends Binding.Service<
  AnalyzeID,
  "AWS.Textract.AnalyzeID",
  () => Effect.Effect<
    (
      request: textract.AnalyzeIDRequest,
    ) => Effect.Effect<textract.AnalyzeIDResponse, textract.AnalyzeIDError>
  >
> {}
export const AnalyzeID = Binding.Service<AnalyzeID>("AWS.Textract.AnalyzeID");

export const AnalyzeIDHttp = Layer.effect(
  AnalyzeID,
  makeTextractHttpBinding({
    capability: "AnalyzeID",
    // No resource-level IAM for this action.
    iamActions: ["textract:AnalyzeID"],
    operation: textract.analyzeID,
  }),
);
