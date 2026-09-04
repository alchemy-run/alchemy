import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { GetIssue, type GetIssueRequest, IssueNotFound } from "./GetIssue.ts";

export const getIssueOperation = BindingHttp.operation(
  "issues.get",
  (octokit, repo) => (request: GetIssueRequest) =>
    octokit.rest.issues.get({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
  {
    // a missing issue is a domain answer, not a wire failure
    mapError: (error, { repo, request: [request] }) =>
      error.status === 404
        ? new IssueNotFound({
            owner: repo.owner,
            repository: repo.repository,
            number: request.issue_number,
          })
        : error,
  },
);

/**
 * Token-backed {@link GetIssue}: captures the provider credential as a
 * `GitHub.PersonalAccessToken` resource bound into the host.
 */
export const GetIssueHttp = Layer.effect(
  GetIssue,
  BindingHttp.make(getIssueOperation),
);
