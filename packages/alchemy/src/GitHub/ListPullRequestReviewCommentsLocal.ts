import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListPullRequestReviewComments } from "./ListPullRequestReviewComments.ts";
import { listPullRequestReviewCommentsOperation } from "./ListPullRequestReviewCommentsHttp.ts";

/** {@link ListPullRequestReviewComments} off the provider's ambient credentials (laptop / Actions / tests). */
export const ListPullRequestReviewCommentsLocal = Layer.effect(
  ListPullRequestReviewComments,
  BindingLocal.make(listPullRequestReviewCommentsOperation),
);
