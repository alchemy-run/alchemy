import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  CreatePullRequestReview,
  type CreatePullRequestReviewRequest,
} from "./CreatePullRequestReview.ts";

export const createPullRequestReviewOperation = BindingHttp.operation(
  "pulls.createReview",
  (octokit, repo) => (request: CreatePullRequestReviewRequest) =>
    octokit.rest.pulls.createReview({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed {@link CreatePullRequestReview}: captures the provider
 * credential as a `GitHub.PersonalAccessToken` resource bound into the
 * host.
 */
export const CreatePullRequestReviewHttp = Layer.effect(
  CreatePullRequestReview,
  BindingHttp.make(createPullRequestReviewOperation),
);
