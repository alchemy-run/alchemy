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
 * Token-backed {@link ListIssues}: captures the provider credential as
 * a `GitHub.PersonalAccessToken` resource bound into the host — the
 * deployed runtime authenticates with the bound token.
 */
export const ListIssuesHttp = Layer.effect(
  ListIssues,
  BindingHttp.make(listIssuesOperation),
);
