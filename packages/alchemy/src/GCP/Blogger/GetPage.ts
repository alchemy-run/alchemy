import type * as blogger from "@distilled.cloud/gcp/blogger_v3";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Page } from "./Page.ts";

export interface GetPageRequest extends Omit<
  blogger.GetPagesRequest,
  "blogId" | "pageId"
> {}

/**
 * Runtime binding for Blogger `pages.get`.
 *
 * Bind this operation to a {@link Page} in a Function/Action init
 * phase. Provide {@link GetPageHttp}.
 *
 * ### Reading Pages
 * **Example:** Read page metadata
 * ```typescript
 * const getPage = yield* GCP.Blogger.GetPage(page);
 * const metadata = yield* getPage({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Blogger
 */
export interface GetPage extends Binding.Service<
  GetPage,
  "GCP.Blogger.GetPage",
  (
    page: Page,
  ) => Effect.Effect<
    (
      request: GetPageRequest,
    ) => Effect.Effect<blogger.Page, blogger.GetPagesError, RuntimeContext>
  >
> {}

export const GetPage = Binding.Service<GetPage>("GCP.Blogger.GetPage");
