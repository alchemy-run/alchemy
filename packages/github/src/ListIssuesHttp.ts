import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { ListIssues, type ListIssuesRequest } from "./ListIssues.ts";

export const listIssuesOperation = BindingHttp.operation(
  "issues.listForRepo",
  (octokit, repo) => (request?: ListIssuesRequest) =>
    octokit.rest.issues.listForRepo({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed implementation of {@link ListIssues}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Issue
 * @provides GitHub.ListIssues
 */
export const ListIssuesHttp = Layer.effect(ListIssues, BindingHttp.make(listIssuesOperation));
