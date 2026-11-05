import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `transcribe:UpdateCallAnalyticsCategory` — replace a Call Analytics category's rules.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:UpdateCallAnalyticsCategory` on `*`.
 *
 * ### Call Analytics Categories
 * **Example:** Update a Call Analytics Category
 * ```typescript
 * // init
 * const updateCallAnalyticsCategory = yield* AWS.Transcribe.UpdateCallAnalyticsCategory();
 *
 * // runtime
 * yield* updateCallAnalyticsCategory({
 *   CategoryName: "long-silence",
 *   Rules: [{ NonTalkTimeFilter: { Threshold: 60000 } }],
 * });
 * ```
 *
 * @binding
 */
export interface UpdateCallAnalyticsCategory extends Binding.Service<
  UpdateCallAnalyticsCategory,
  "AWS.Transcribe.UpdateCallAnalyticsCategory",
  () => Effect.Effect<
    (
      request: transcribe.UpdateCallAnalyticsCategoryRequest,
    ) => Effect.Effect<
      transcribe.UpdateCallAnalyticsCategoryResponse,
      transcribe.UpdateCallAnalyticsCategoryError
    >
  >
> {}
export const UpdateCallAnalyticsCategory = Binding.Service<UpdateCallAnalyticsCategory>(
  "AWS.Transcribe.UpdateCallAnalyticsCategory",
);

export const UpdateCallAnalyticsCategoryHttp = Layer.effect(
  UpdateCallAnalyticsCategory,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.UpdateCallAnalyticsCategory",
    operation: transcribe.updateCallAnalyticsCategory,
    actions: ["transcribe:UpdateCallAnalyticsCategory"],
  }),
);
