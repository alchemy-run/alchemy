import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  ListPullRequestReviewComments,
  type ListPullRequestReviewCommentsRequest,
} from "./ListPullRequestReviewComments.ts";

export const listPullRequestReviewCommentsOperation = BindingHttp.operation(
  "pulls.listReviewComments",
  (octokit, repo) => (request: ListPullRequestReviewCommentsRequest) =>
    octokit.rest.pulls.listReviewComments({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed implementation of {@link ListPullRequestReviewComments}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.ListPullRequestReviewComments
 */
export const ListPullRequestReviewCommentsHttp = Layer.effect(
  ListPullRequestReviewComments,
  BindingHttp.make(listPullRequestReviewCommentsOperation),
);
