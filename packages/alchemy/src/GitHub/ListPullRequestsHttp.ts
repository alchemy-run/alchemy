import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  ListPullRequests,
  type ListPullRequestsRequest,
} from "./ListPullRequests.ts";

export const listPullRequestsOperation = BindingHttp.operation(
  "pulls.list",
  (octokit, repo) => (request?: ListPullRequestsRequest) =>
    octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed {@link ListPullRequests}: captures the provider
 * credential as a `GitHub.PersonalAccessToken` resource bound into the
 * host.
 */
export const ListPullRequestsHttp = Layer.effect(
  ListPullRequests,
  BindingHttp.make(listPullRequestsOperation),
);
