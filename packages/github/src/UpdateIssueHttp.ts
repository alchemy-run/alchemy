import * as Layer from "effect/Layer";
import { IssueNotFound } from "./ApiError.ts";
import * as BindingHttp from "./BindingHttp.ts";
import { UpdateIssue, type UpdateIssueRequest } from "./UpdateIssue.ts";

export const updateIssueOperation = BindingHttp.operation(
  "issues.update",
  (octokit, repo) => (request: UpdateIssueRequest) =>
    octokit.rest.issues.update({
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
 * Token-backed implementation of {@link UpdateIssue}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Issue
 * @provides GitHub.UpdateIssue
 */
export const UpdateIssueHttp = Layer.effect(UpdateIssue, BindingHttp.make(updateIssueOperation));
