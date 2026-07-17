import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  ListPullRequestReviews,
  type ListPullRequestReviewsRequest,
} from "./ListPullRequestReviews.ts";

export const listPullRequestReviewsOperation = BindingHttp.operation(
  "pulls.listReviews",
  (octokit, repo) => (request: ListPullRequestReviewsRequest) =>
    octokit.rest.pulls.listReviews({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed {@link ListPullRequestReviews}: captures the provider
 * credential as a `GitHub.PersonalAccessToken` resource bound into the
 * host.
 */
export const ListPullRequestReviewsHttp = Layer.effect(
  ListPullRequestReviews,
  BindingHttp.make(listPullRequestReviewsOperation),
);
