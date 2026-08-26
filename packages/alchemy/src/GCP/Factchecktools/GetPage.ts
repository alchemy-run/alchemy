import type * as factchecktools from "@distilled.cloud/gcp/factchecktools_v1alpha1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Page } from "./Page.ts";

export interface GetPageRequest extends Omit<
  factchecktools.GetPagesRequest,
  "name"
> {}

/**
 * Runtime binding for Fact Check Tools `pages.get`.
 *
 * Bind this operation to a {@link Page} in a Function/Action init
 * phase. Provide {@link GetPageHttp}.
 *
 * ### Reading Pages
 * **Example:** Read ClaimReview markup
 * ```typescript
 * const getPage = yield* GCP.Factchecktools.GetPage(page);
 * const markup = yield* getPage({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Factchecktools
 */
export interface GetPage extends Binding.Service<
  GetPage,
  "GCP.Factchecktools.GetPage",
  (
    page: Page,
  ) => Effect.Effect<
    (
      request: GetPageRequest,
    ) => Effect.Effect<
      factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimReviewMarkupPage,
      factchecktools.GetPagesError,
      RuntimeContext
    >
  >
> {}

export const GetPage = Binding.Service<GetPage>("GCP.Factchecktools.GetPage");
