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
 * Token-backed {@link ListPullRequestReviewComments}: captures the
 * provider credential as a `GitHub.PersonalAccessToken` resource bound
 * into the host.
 */
export const ListPullRequestReviewCommentsHttp = Layer.effect(
  ListPullRequestReviewComments,
  BindingHttp.make(listPullRequestReviewCommentsOperation),
);
