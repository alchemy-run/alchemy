import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { IssueNotFound } from "./GetIssue.ts";
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
 * Token-backed {@link UpdateIssue}: captures the provider credential
 * as a `GitHub.PersonalAccessToken` resource bound into the host.
 */
export const UpdateIssueHttp = Layer.effect(
  UpdateIssue,
  BindingHttp.make(updateIssueOperation),
);
