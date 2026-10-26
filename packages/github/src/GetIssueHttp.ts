import * as Layer from "effect/Layer";
import { IssueNotFound } from "./ApiError.ts";
import * as BindingHttp from "./BindingHttp.ts";
import { GetIssue, type GetIssueRequest } from "./GetIssue.ts";

export const getIssueOperation = BindingHttp.operation(
  "issues.get",
  (octokit, repo) => (request: GetIssueRequest) =>
    octokit.rest.issues.get({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
  {
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
 * Token-backed implementation of {@link GetIssue}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Issue
 * @provides GitHub.GetIssue
 */
export const GetIssueHttp = Layer.effect(GetIssue, BindingHttp.make(getIssueOperation));
