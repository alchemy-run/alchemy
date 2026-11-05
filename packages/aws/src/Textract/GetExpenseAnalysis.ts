import * as textract from "@distilled.cloud/aws/textract";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `textract:GetExpenseAnalysis` — read the status and
 * results of an asynchronous expense-analysis job started with
 * `StartExpenseAnalysis`.
 *
 * ### Asynchronous Expense Analysis
 * **Example:** Poll an Expense Analysis Job
 * ```typescript
 * // init
 * const getExpenseAnalysis = yield* AWS.Textract.GetExpenseAnalysis();
 *
 * // runtime
 * const result = yield* getExpenseAnalysis({ JobId: jobId });
 * const documents = result.ExpenseDocuments;
 * ```
 *
 * @binding
 */
export interface GetExpenseAnalysis extends Binding.Service<
  GetExpenseAnalysis,
  "AWS.Textract.GetExpenseAnalysis",
  () => Effect.Effect<
    (
      request: textract.GetExpenseAnalysisRequest,
    ) => Effect.Effect<textract.GetExpenseAnalysisResponse, textract.GetExpenseAnalysisError>
  >
> {}
export const GetExpenseAnalysis = Binding.Service<GetExpenseAnalysis>(
  "AWS.Textract.GetExpenseAnalysis",
);

export const GetExpenseAnalysisHttp = Layer.effect(
  GetExpenseAnalysis,
  makeTextractHttpBinding({
    capability: "GetExpenseAnalysis",
    // No resource-level IAM for this action.
    iamActions: ["textract:GetExpenseAnalysis"],
    operation: textract.getExpenseAnalysis,
  }),
);
