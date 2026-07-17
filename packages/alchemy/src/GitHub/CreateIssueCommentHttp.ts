import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  CreateIssueComment,
  type CreateIssueCommentRequest,
} from "./CreateIssueComment.ts";

export const createIssueCommentOperation = BindingHttp.operation(
  "issues.createComment",
  (octokit, repo) => (request: CreateIssueCommentRequest) =>
    octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed {@link CreateIssueComment}: captures the provider
 * credential as a `GitHub.PersonalAccessToken` resource bound into the
 * host.
 */
export const CreateIssueCommentHttp = Layer.effect(
  CreateIssueComment,
  BindingHttp.make(createIssueCommentOperation),
);
