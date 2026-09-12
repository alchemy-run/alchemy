import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  ListIssueComments,
  type ListIssueCommentsRequest,
} from "./ListIssueComments.ts";

export const listIssueCommentsOperation = BindingHttp.operation(
  "issues.listComments",
  (octokit, repo) => (request: ListIssueCommentsRequest) =>
    octokit.rest.issues.listComments({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed {@link ListIssueComments}: captures the provider
 * credential as a `GitHub.PersonalAccessToken` resource bound into the
 * host.
 */
export const ListIssueCommentsHttp = Layer.effect(
  ListIssueComments,
  BindingHttp.make(listIssueCommentsOperation),
);
