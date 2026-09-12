import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { CreatePullRequestReview } from "./CreatePullRequestReview.ts";
import { createPullRequestReviewOperation } from "./CreatePullRequestReviewHttp.ts";

/** {@link CreatePullRequestReview} off the provider's ambient credentials (laptop / Actions / tests). */
export const CreatePullRequestReviewLocal = Layer.effect(
  CreatePullRequestReview,
  BindingLocal.make(createPullRequestReviewOperation),
);
