import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListPullRequestReviews } from "./ListPullRequestReviews.ts";
import { listPullRequestReviewsOperation } from "./ListPullRequestReviewsHttp.ts";

/** {@link ListPullRequestReviews} off the provider's ambient credentials (laptop / Actions / tests). */
export const ListPullRequestReviewsLocal = Layer.effect(
  ListPullRequestReviews,
  BindingLocal.make(listPullRequestReviewsOperation),
);
